import { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { NetClient } from '../../assets/scripts/net/NetClient';
import { ServerMessage } from '../../assets/scripts/net/protocol';
import { RoomManager } from '../../server/src/RoomManager';
import { createWsServer } from '../../server/src/server';

describe('NetClient', () => {
  let wss: WebSocketServer | null = null;

  afterEach(async () => {
    if (wss) {
      await new Promise<void>((resolve) => wss!.close(() => resolve()));
      wss = null;
    }
  });

  it('connects, exchanges messages and reports closure', async () => {
    wss = createWsServer(new RoomManager(), 0);
    await new Promise<void>((resolve) => wss!.once('listening', resolve));
    const port = (wss.address() as AddressInfo).port;

    const client = new NetClient(`ws://127.0.0.1:${port}`, (url) => new WebSocket(url) as never);
    const received: ServerMessage[] = [];
    let closed = false;
    client.onMessage = (message) => received.push(message);
    client.onClose = () => {
      closed = true;
    };

    await client.connect();
    client.send({ type: 'createRoom', nickname: 'Alice' });

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (received.some((message) => message.type === 'joined')) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });

    const joined = received.find((message) => message.type === 'joined')!;
    expect(joined.roomCode).toMatch(/^[A-Z2-9]{4}$/);

    expect(closed).toBe(false);
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(true);
  });
});
