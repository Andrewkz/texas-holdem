import { WebSocket, WebSocketServer } from 'ws';

import { parseClientMessage } from '../../assets/scripts/net/protocol';
import type { ServerMessage } from '../../assets/scripts/net/protocol';
import { RoomManager } from './RoomManager';

export function createWsServer(manager: RoomManager, port: number): WebSocketServer {
  const wss = new WebSocketServer({ port, maxPayload: 16 * 1024 });

  wss.on('connection', (socket: WebSocket) => {
    const connection = {
      send: (message: ServerMessage) => socket.send(JSON.stringify(message)),
    };
    manager.handleOpen(connection);

    // ws 会把对端异常（RST、坏帧）以 error 事件抛出，无监听时会击穿进程；
    // ws 保证 error 之后必发 close，清理由 close 分支负责
    socket.on('error', (error) => console.error('socket error', error));

    socket.on('message', (data) => {
      let raw: unknown;

      try {
        raw = JSON.parse(data.toString());
      } catch {
        connection.send({ type: 'error', code: 'bad-message', message: '无法解析的消息' });
        return;
      }

      const message = parseClientMessage(raw);

      if (!message) {
        connection.send({ type: 'error', code: 'bad-message', message: '无法解析的消息' });
        return;
      }

      try {
        manager.handleMessage(connection, message);
      } catch (error) {
        // 兜底：内部异常（如房间码耗尽）不能击穿进程
        console.error('handle message failed', error);
        connection.send({ type: 'error', code: 'bad-message', message: '服务器内部错误' });
      }
    });

    socket.on('close', () => manager.handleClose(connection));
  });

  return wss;
}
