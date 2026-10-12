import { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { ClientMessage, ServerMessage } from '../../assets/scripts/net/protocol';
import { RoomManager } from '../../server/src/RoomManager';
import { createWsServer } from '../../server/src/server';

class TestClient {
  public readonly messages: ServerMessage[] = [];
  private readonly socket: WebSocket;
  private waiter: { type: ServerMessage['type']; resolve: (message: ServerMessage) => void } | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      this.messages.push(message);

      if (this.waiter?.type === message.type) {
        this.waiter.resolve(message);
        this.waiter = null;
      }
    });
  }

  public static async connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return new TestClient(socket);
  }

  public send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  public waitFor<T extends ServerMessage['type']>(type: T): Promise<Extract<ServerMessage, { type: T }>> {
    const existing = this.messages.find((message) => message.type === type);

    if (existing) {
      return Promise.resolve(existing as Extract<ServerMessage, { type: T }>);
    }

    return new Promise((resolve) => {
      this.waiter = { type, resolve: resolve as (message: ServerMessage) => void };
    });
  }

  public close(): void {
    this.socket.close();
  }
}

describe('websocket server', () => {
  let wss: WebSocketServer | null = null;

  afterEach(async () => {
    if (wss) {
      await new Promise<void>((resolve) => wss!.close(() => resolve()));
      wss = null;
    }
  });

  it('serves a full two-player hand over real sockets without leaking hole cards', async () => {
    const manager = new RoomManager({ betweenHandsMs: 60_000, actionTimeoutMs: 60_000 });
    wss = createWsServer(manager, 0);
    await new Promise<void>((resolve) => wss!.once('listening', resolve));
    const port = (wss.address() as AddressInfo).port;

    const alice = await TestClient.connect(port);
    const bob = await TestClient.connect(port);

    alice.send({ type: 'createRoom', nickname: 'Alice' });
    const joined = await alice.waitFor('joined');

    bob.send({ type: 'joinRoom', roomCode: joined.roomCode, nickname: 'Bob' });
    await bob.waitFor('joined');

    alice.send({ type: 'startGame' });
    const [aliceHand, bobHand] = await Promise.all([
      alice.waitFor('yourHand'),
      bob.waitFor('yourHand'),
    ]);

    expect(aliceHand.cards).toHaveLength(2);
    expect(bobHand.cards).toHaveLength(2);

    const bobWire = JSON.stringify(bob.messages);
    for (const card of aliceHand.cards) {
      expect(bobWire).not.toContain(JSON.stringify(card));
    }

    const sync = await alice.waitFor('stateSync');
    expect(sync.snapshot.pot).toBe(60);

    alice.close();
    bob.close();
  });

  it('rejects malformed JSON with a bad-message error', async () => {
    const manager = new RoomManager();
    wss = createWsServer(manager, 0);
    await new Promise<void>((resolve) => wss!.once('listening', resolve));
    const port = (wss.address() as AddressInfo).port;

    const raw = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => raw.once('open', () => resolve()));
    raw.send('not json');

    const error = await new Promise<{ code: string }>((resolve) => {
      raw.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(error.code).toBe('bad-message');

    raw.close();
  });
});
