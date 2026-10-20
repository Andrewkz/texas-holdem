import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { parseClientMessage, PROTOCOL_VERSION } from '../../assets/scripts/net/protocol';
import type { ServerMessage } from '../../assets/scripts/net/protocol';
import { RoomManager } from './RoomManager';
type TrackedSocket = WebSocket & {
  isAlive?: boolean;
};
export function createWsServer(manager: RoomManager, port: number, heartbeatMs = 30000, host?: string): WebSocketServer & {
  httpServer: Server;
} {
  const httpServer = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'application/json; charset=utf-8');
    const match = /^\/api\/settlements\/([A-Za-z0-9_-]+)$/.exec((request.url ?? '').split('?')[0]);
    if (request.method !== 'GET' || !match) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not-found' }));
      return;
    }
    const result = manager.getSettlement(match[1]);
    response.statusCode = result.status;
    response.end(JSON.stringify(result.status === 200 ? result.settlement : { error: result.status === 410 ? 'expired' : 'not-found' }));
  });
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 16 * 1024 });
  // Retain the existing WebSocketServer API while exposing the shared HTTP listener.
  Object.defineProperty(wss, 'httpServer', { value: httpServer });
  const close = wss.close.bind(wss);
  wss.close = (callback?: (error?: Error) => void) => close(error => { manager.dispose(); httpServer.close(httpError => callback?.(error ?? httpError)); });
  httpServer.listen(port, host);
  wss.on('connection', (socket: WebSocket) => {
    const tracked = socket as TrackedSocket;
    tracked.isAlive = true;
    socket.on('pong', () => {
      tracked.isAlive = true;
    });
    const connection = {
      send: (message: ServerMessage) => socket.send(JSON.stringify(message)),
      close: () => socket.close(),
    };
    manager.handleOpen(connection);
    let negotiated = false;
    // ws 会把对端异常（RST、坏帧）以 error 事件抛出，无监听时会击穿进程；
    // ws 保证 error 之后必发 close，清理由 close 分支负责
    socket.on('error', (error) => console.error('socket error', error));
    socket.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      }
      catch {
        connection.send({ type: 'error', code: 'bad-message', message: '无法解析的消息' });
        return;
      }
      if (!negotiated && raw && typeof raw === 'object' && (raw as {
        type?: unknown;
      }).type !== 'hello') {
        connection.send({ type: 'error', code: 'protocol-mismatch', message: '联机版本不兼容，请刷新或升级页面' });
        return;
      }
      const message = parseClientMessage(raw);
      if (!message) {
        connection.send({ type: 'error', code: 'bad-message', message: '无法解析的消息' });
        return;
      }
      if ((!negotiated && message.type !== 'hello')
        || (message.type === 'hello' && (negotiated || message.protocolVersion !== PROTOCOL_VERSION))) {
        connection.send({ type: 'error', code: 'protocol-mismatch', message: '联机版本不兼容，请刷新或升级页面' });
        return;
      }
      try {
        manager.handleMessage(connection, message);
        if (message.type === 'hello')
          negotiated = true;
      }
      catch (error) {
        // 兜底：内部异常（如房间码耗尽）不能击穿进程
        console.error('handle message failed', error);
        connection.send({ type: 'error', code: 'bad-message', message: '服务器内部错误' });
      }
    });
    socket.on('close', () => manager.handleClose(connection));
  });
  // 心跳：静默断开的半开连接（NAT 断线等）不会触发 close，用 ping/pong 兜底 terminate
  if (heartbeatMs > 0) {
    const interval = setInterval(() => {
      for (const socket of wss.clients) {
        const tracked = socket as TrackedSocket;
        if (tracked.isAlive === false) {
          tracked.terminate();
          continue;
        }
        tracked.isAlive = false;
        tracked.ping();
      }
    }, heartbeatMs);
    wss.on('close', () => clearInterval(interval));
  }
  return wss as WebSocketServer & {
    httpServer: Server;
  };
}
