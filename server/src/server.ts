import { WebSocket, WebSocketServer } from 'ws';

import { parseClientMessage, ServerMessage } from '../../assets/scripts/net/protocol';
import { RoomManager } from './RoomManager';

export function createWsServer(manager: RoomManager, port: number): WebSocketServer {
  const wss = new WebSocketServer({ port });

  wss.on('connection', (socket: WebSocket) => {
    const connection = {
      send: (message: ServerMessage) => socket.send(JSON.stringify(message)),
    };
    manager.handleOpen(connection);

    socket.on('message', (data) => {
      try {
        const raw: unknown = JSON.parse(data.toString());
        const message = parseClientMessage(raw);

        if (!message) {
          connection.send({ type: 'error', code: 'bad-message', message: '无法解析的消息' });
          return;
        }

        manager.handleMessage(connection, message);
      } catch (error) {
        // 兜底：任何处理异常（包括 JSON 解析与意外的内部错误）都不能击穿进程
        console.error('handle message failed', error);
        connection.send({ type: 'error', code: 'bad-message', message: '无法解析的消息' });
      }
    });

    socket.on('close', () => manager.handleClose(connection));
  });

  return wss;
}
