import { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { NetClient, WebSocketLike } from '../../assets/scripts/net/NetClient';
import { ServerMessage } from '../../assets/scripts/net/protocol';
import { RoomManager } from '../../server/src/RoomManager';
import { createWsServer } from '../../server/src/server';

const nodeSocketFactory = (url: string) => new WebSocket(url) as unknown as WebSocketLike;

describe('NetClient', () => {
  let wss: WebSocketServer | null = null;

  afterEach(async () => {
    if (wss) {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss!.close(() => resolve()));
      wss = null;
    }
  });

  async function listen(): Promise<number> {
    wss = createWsServer(new RoomManager(), 0);
    await new Promise<void>((resolve) => wss!.once('listening', resolve));
    return (wss.address() as AddressInfo).port;
  }

  it('connects, exchanges messages and reports closure', async () => {
    const port = await listen();

    const client = new NetClient(`ws://127.0.0.1:${port}`, nodeSocketFactory);
    const received: ServerMessage[] = [];
    let closed = false;
    client.onMessage = (message) => received.push(message);
    client.onClose = () => {
      closed = true;
    };

    await client.connect();
    client.send({ type: 'createRoom', nickname: 'Alice' });

    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (received.some((message) => message.type === 'joined')) {
          clearInterval(timer);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
      const timeout = setTimeout(() => {
        clearInterval(timer);
        reject(new Error('timed out waiting for joined message'));
      }, 3000);
    });

    const joined = received.find((message) => message.type === 'joined')!;
    expect(joined.roomCode).toMatch(/^[A-Z2-9]{4}$/);

    expect(closed).toBe(false);
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(true);
  });

  it('rejects when the server is unreachable', async () => {
    const client = new NetClient('ws://127.0.0.1:1', nodeSocketFactory);
    await expect(client.connect()).rejects.toThrow();
  });

  it('rejects a second connect while already connected', async () => {
    const port = await listen();
    const client = new NetClient(`ws://127.0.0.1:${port}`, nodeSocketFactory);

    await client.connect();
    try {
      await expect(client.connect()).rejects.toThrow('已连接或正在连接');
    } finally {
      client.close();
    }
  });

  it('rejects the connect promise when the socket closes before opening', async () => {
    const fake: WebSocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: () => {},
      close: () => {},
    };
    const client = new NetClient('ws://unused.test', () => fake);

    const pending = client.connect();
    fake.onclose?.();

    const outcome = await Promise.race([
      pending.then(() => 'resolved', (error: Error) => error.message),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 500)),
    ]);
    expect(outcome).toBe('连接已关闭');
  });
});
