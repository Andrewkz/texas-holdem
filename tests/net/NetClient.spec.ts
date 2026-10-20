import { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as protocol from '../../assets/scripts/net/protocol';

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
    client.send({ type: 'createRoom', nickname: 'Alice',requestId:'r',token:'a'.repeat(64) });

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

describe('NetClient negotiated lifecycle', () => {
  function setup(timings = { connectTimeoutMs: 20, helloTimeoutMs: 10, joinedTimeoutMs: 10 }) {
    const sockets: WebSocketLike[] = [];
    const sent: unknown[] = [];
    const client = new NetClient('ws://test', () => {
      const socket: WebSocketLike = { onopen: null, onmessage: null, onerror: null, onclose: null,
        send: (data) => sent.push(JSON.parse(data)), close: () => undefined };
      sockets.push(socket);
      return socket;
    }, timings);
    return { client, sockets, sent };
  }
  it('sends only hello before matching acknowledgement', async () => {
    const { client, sockets, sent } = setup();
    let connected = false;
    const pending = client.connect().then(() => { connected = true; });
    sockets[0].onopen?.();
    client.send({ type: 'reconnect', sessionId:'s', token: 'secret' });
    expect(connected).toBe(false);
    expect(sent).toEqual([{ type: 'hello', protocolVersion: protocol.PROTOCOL_VERSION }]);
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'hello', protocolVersion: protocol.PROTOCOL_VERSION }) });
    await pending;
    expect(connected).toBe(true);
    client.close();
  });
  it.each([
    { type: 'hello', protocolVersion: 1 },
    { type: 'error', code: 'bad-message', message: 'unknown hello' },
    { type: 'hello' },
  ])('rejects incompatible acknowledgement %j', async (message) => {
    const { client, sockets } = setup();
    const result = client.connect();
    sockets[0].onopen?.();
    sockets[0].onmessage?.({ data: JSON.stringify(message) });
    await expect(result).rejects.toMatchObject({ code: 'protocol-mismatch' });
  });
  it('bounds opening, hello and joined waits', async () => {
    const { client, sockets } = setup();
    await expect(client.connect()).rejects.toThrow('连接超时');
    const hello = client.connect();
    sockets[1].onopen?.();
    await expect(hello).rejects.toMatchObject({ code: 'protocol-mismatch' });
    const third = client.connect();
    sockets[2].onopen?.();
    sockets[2].onmessage?.({ data: JSON.stringify({ type: 'hello', protocolVersion: protocol.PROTOCOL_VERSION }) });
    await third;
    await expect(client.waitForJoined()).rejects.toThrow('座位确认超时');
    client.close();
  });
  it('ignores old close and late acknowledgement after cancellation', async () => {
    const { client, sockets } = setup();
    const first = client.connect();
    const cancelled = expect(first).rejects.toThrow('连接已取消');
    client.close();
    await cancelled;
    let closed = 0;
    client.onClose = () => { closed += 1; };
    const second = client.connect();
    sockets[0].onclose?.();
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'hello', protocolVersion: protocol.PROTOCOL_VERSION }) });
    sockets[1].onopen?.();
    sockets[1].onmessage?.({ data: JSON.stringify({ type: 'hello', protocolVersion: protocol.PROTOCOL_VERSION }) });
    await second;
    expect(closed).toBe(0);
    client.close();
  });
  it('fails closed on a push missing required participation fields', async () => {
    const { client, sockets } = setup();
    const received: ServerMessage[] = [];
    client.onMessage = (message) => received.push(message);
    const pending = client.connect();
    sockets[0].onopen?.();
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'hello', protocolVersion: protocol.PROTOCOL_VERSION }) });
    await pending;
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'handStart', handId: 1, dealerPlayerId: 'p1' }) });
    expect(received).toContainEqual(expect.objectContaining({ type: 'error', code: 'protocol-mismatch' }));
    expect(received.some((message) => message.type === 'handStart')).toBe(false);
  });
});


describe('NetClient compiled iterable compatibility', () => {
  it.each(['joined', 'cancel'] as const)('settles the joined waiter after %s in a target without iterator spread helpers', async (outcome) => {
    // Cocos loose spread and legacy TS targets do not preserve Set spread semantics.
    // Execute the real client after downlevel compilation to catch that boundary.
    const source = readFileSync(new URL('../../assets/scripts/net/NetClient.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.CommonJS, downlevelIteration: false } }).outputText;
    const exported: { NetClient?: typeof NetClient } = {};
    new Function('exports', 'require', compiled)(exported, () => protocol);
    const fake: WebSocketLike = { onopen: null, onmessage: null, onerror: null, onclose: null, send: () => undefined, close: () => undefined };
    const client = new exported.NetClient!('ws://compiled', () => fake, { joinedTimeoutMs: 10 });
    const connecting = client.connect();
    fake.onopen?.();
    fake.onmessage?.({ data: JSON.stringify({ type: 'hello', protocolVersion: protocol.PROTOCOL_VERSION }) });
    await connecting;
    const joined = client.waitForJoined().then(() => 'joined', (error: Error) => error.message);
    if (outcome === 'joined') {
      fake.onmessage?.({ data: JSON.stringify({ type: 'joined',sessionId:'s', roomCode: 'AB23', playerId: 'p1', token: 'tok', room: {
        code: 'AB23',session:{sessionId:'s',tableEpoch:'epoch',lifecycle:'active',checkpointVersion:0,allOfflineDeadline:null}, phase: 'lobby', hostId: 'p1', seats: [{ playerId: 'p1', nickname: 'Alice', stack: 5000, connected: true }],
      } }) });
    } else client.close();
    const result = await Promise.race([joined, new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 20))]);
    expect(result).toBe(outcome === 'joined' ? 'joined' : '连接已取消');
    client.close();
  });
});
