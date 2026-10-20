import { PROTOCOL_VERSION } from '../../assets/scripts/net/protocol';
import { setBoundaryStacks } from './v3Commands';
import { randomBytes, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { ClientMessage, ServerMessage, parseServerMessage } from '../../assets/scripts/net/protocol';
import { RoomManager } from '../../server/src/RoomManager';
import { createWsServer } from '../../server/src/server';
class TestClient {
  private static readonly sessions = new Map<string, string>();
  public readonly messages: ServerMessage[] = [];
  private readonly socket: WebSocket;
  private latestJoined: Extract<ServerMessage, {
    type: 'joined';
  }> | undefined;
  private latestSync: Extract<ServerMessage, {
    type: 'stateSync';
  }> | undefined;
  private waiter: {
    type: ServerMessage['type'];
    resolve: (message: ServerMessage) => void;
  } | null = null;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      this.messages.push(message);
      if (message.type === 'joined') {
        TestClient.sessions.set(message.roomCode, message.sessionId);
        this.latestJoined = message;
      }
      if (message.type === 'stateSync')
        this.latestSync = message;
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
    const client = new TestClient(socket);
    client.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
    expect(await client.waitFor('hello')).toEqual({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
    return client;
  }
  public send(message: Record<string, unknown>): void {
    const joined = this.latestJoined;
    const sync = this.latestSync;
    let result = { ...message };
    if (message.type === 'createRoom' || message.type === 'joinRoom')
      result = { requestId: randomUUID(), token: randomBytes(32).toString('hex'), ...result };
    if (message.type === 'joinRoom' || message.type === 'reconnect')
      result = { sessionId: TestClient.sessions.get(message.roomCode as string), ...result };
    if (['startGame', 'rebuy', 'leaveRoom', 'requestEnd', 'commandStatus'].includes(message.type as string))
      result = { sessionId: joined?.sessionId, requestId: randomUUID(), ...result };
    if (message.type === 'action')
      result = { sessionId: joined?.sessionId, tableEpoch: sync?.tableEpoch, handId: sync?.snapshot.handId, ...result };
    this.socket.send(JSON.stringify(result));
  }
  public waitFor<T extends ServerMessage['type']>(type: T): Promise<Extract<ServerMessage, {
    type: T;
  }>> {
    const existing = this.messages.find((message) => message.type === type);
    if (existing) {
      return Promise.resolve(existing as Extract<ServerMessage, {
        type: T;
      }>);
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
      for (const socket of wss.clients)
        socket.terminate();
      await new Promise<void>((resolve) => wss!.close(() => resolve()));
      wss = null;
    }
  });
  it('binds only the requested loopback host', async () => {
    wss = createWsServer(new RoomManager(), 0, 30000, '127.0.0.1');
    await new Promise<void>((resolve) => wss!.once('listening', resolve));
    expect((wss.address() as AddressInfo).address).toBe('127.0.0.1');
  });
  it('serves a full two-player hand over real sockets without leaking hole cards', async () => {
    const manager = new RoomManager({ betweenHandsMs: 60000, actionTimeoutMs: 60000 });
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
    for (const message of [...alice.messages, ...bob.messages])
      expect(parseServerMessage(message)).not.toBeNull();
    const bobWire = JSON.stringify(bob.messages);
    for (const card of aliceHand.cards) {
      expect(bobWire).not.toContain(JSON.stringify(card));
    }
    const sync = await alice.waitFor('stateSync');
    expect(sync.snapshot.pot).toBe(60);
    alice.close();
    bob.close();
  });
  it('delivers joined, frozen hand identities and private/public recovery state without transition delays', async () => {
    const manager = new RoomManager({ betweenHandsMs: 60000, actionTimeoutMs: 60000 });
    wss = createWsServer(manager, 0);
    await new Promise<void>(resolve => wss!.once('listening', resolve));
    const port = (wss.address() as AddressInfo).port;
    const alice = await TestClient.connect(port);
    const bob = await TestClient.connect(port);
    alice.send({ type: 'createRoom', nickname: 'Alice' });
    const owner = await alice.waitFor('joined');
    bob.send({ type: 'joinRoom', roomCode: owner.roomCode, nickname: 'Bob' });
    const seat = await bob.waitFor('joined');
    alice.send({ type: 'startGame' });
    const initial = await alice.waitFor('stateSync');
    const carol = await TestClient.connect(port);
    carol.send({ type: 'joinRoom', roomCode: owner.roomCode, nickname: 'Carol' });
    const waiting = await carol.waitFor('stateSync');
    expect(carol.messages.filter(m => m.type !== 'hello').map(m => m.type))
      .toEqual(['joined', 'roomState', 'ledgerSync', 'handStart', 'stateSync']);
    expect(waiting.participation).toBe('waiting-next-hand');
    expect(waiting.snapshot.legalActions).toEqual([]);
    const actor = initial.snapshot.actingPlayerId === owner.playerId ? alice : bob;
    const actorState = await actor.waitFor('stateSync');
    const call = actorState.snapshot.legalActions.find(a => a.type === 'call')!;
    expect(call).toBeDefined();
    carol.messages.length = 0;
    actor.send({ type: 'action', action: call });
    const stillWaiting = await carol.waitFor('stateSync');
    expect(stillWaiting.participation).toBe('waiting-next-hand');
    expect(stillWaiting.snapshot.legalActions).toEqual([]);
    expect(carol.messages.some(m => m.type === 'yourHand')).toBe(false);
    const back = await TestClient.connect(port);
    back.send({ type: 'reconnect', roomCode: owner.roomCode, token: seat.token });
    const recovered = await back.waitFor('stateSync');
    expect(back.messages.filter(m => m.type !== 'hello').map(m => m.type))
      .toEqual(['joined', 'roomState', 'ledgerSync', 'handStart', 'yourHand', 'stateSync']);
    expect(back.messages.find(m => m.type === 'joined')).toMatchObject({ playerId: seat.playerId, token: seat.token });
    expect(recovered.participation).toBe('playing-hand');
    for (const message of [...carol.messages, ...back.messages])
      expect(parseServerMessage(message)).not.toBeNull();
    alice.close();
    bob.close();
    carol.close();
    back.close();
  });
  it('commits rebuy/receipt at a real WS hand boundary and serves the final shared HTTP result', async () => {
    const manager = new RoomManager({ betweenHandsMs: 60000, actionTimeoutMs: 60000 });
    wss = createWsServer(manager, 0, 0, '127.0.0.1');
    await new Promise<void>(resolve => wss!.once('listening', resolve));
    const port = (wss.address() as AddressInfo).port;
    const alice = await TestClient.connect(port);
    const bob = await TestClient.connect(port);
    alice.send({ type: 'createRoom', nickname: 'Alice' });
    const owner = await alice.waitFor('joined');
    bob.send({ type: 'joinRoom', roomCode: owner.roomCode, nickname: 'Bob' });
    const peer = await bob.waitFor('joined');
    const room = manager.getRoom(owner.sessionId)!;
    setBoundaryStacks(room, { [owner.playerId]: 0, [peer.playerId]: 10000 });
    alice.messages.length = 0;
    bob.messages.length = 0;
    alice.send({ type: 'rebuy', requestId: 'ws-rebuy' });
    expect((await alice.waitFor('commandResult')).result).toMatchObject({ requestId: 'ws-rebuy', status: 'pending' });
    expect(room.ledgerSnapshot().rows[0].stack).toBe(0);
    alice.messages.length = 0;
    alice.send({ type: 'startGame' });
    await alice.waitFor('handStart');
    expect(room.commandStatus(owner.playerId, 'ws-rebuy')?.status).toBe('committed');
    expect(room.ledgerSnapshot().rows[0]).toMatchObject({ stack: 5000, totalBuyIn: 10000, rebuyCount: 1 });
    expect(alice.messages.find(m => m.type === 'ledgerSync')).toMatchObject({ ledger: { rows: expect.arrayContaining([expect.objectContaining({ playerId: owner.playerId, rebuyCount: 1 })]) } });
    alice.messages.length = 0;
    alice.send({ type: 'commandStatus', requestId: 'ws-rebuy' });
    expect((await alice.waitFor('commandResult')).result.status).toBe('committed');
    alice.messages.length = 0;
    alice.send({ type: 'requestEnd', requestId: 'ws-end' });
    await alice.waitFor('commandResult');
    // The engine actor is authoritative, so use its latest full scoped state.
    const sync = Array.from(bob.messages).reverse().find(m => m.type === 'stateSync') as Extract<ServerMessage, {
      type: 'stateSync';
    }>;
    const acting = sync.snapshot.actingPlayerId === owner.playerId ? alice : bob;
    acting.send({ type: 'action', sessionId: owner.sessionId, tableEpoch: sync.tableEpoch, handId: sync.snapshot.handId, action: { type: 'fold' } });
    const ended = await alice.waitFor('sessionEnded');
    const response = await fetch(`http://127.0.0.1:${port}/api/settlements/${ended.settlement.shareId}`);
    expect(await response.json()).toEqual(ended.settlement);
    expect(ended.settlement.rows.reduce((sum, p) => sum + p.net, 0)).toBe(0);
    const outsider = await TestClient.connect(port);
    outsider.send({ type: 'reconnect', sessionId: owner.sessionId, token: ended.settlement.shareId });
    expect((await outsider.waitFor('error')).code).toBe('invalid-proof');
    for (const message of [...alice.messages, ...bob.messages])
      expect(parseServerMessage(message)).not.toBeNull();
    alice.close();
    bob.close();
    outsider.close();
  });
  it('rejects old clients and incompatible versions before allocating any seat', async () => {
    const manager = new RoomManager();
    const dispatch = vi.spyOn(manager, 'handleMessage');
    wss = createWsServer(manager, 0);
    await new Promise<void>(resolve => wss!.once('listening', resolve));
    const raw = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
    await new Promise<void>(resolve => raw.once('open', resolve));
    const receive = () => new Promise<ServerMessage>(resolve => raw.once('message', data => resolve(JSON.parse(data.toString()))));
    const oldResult = receive();
    raw.send(JSON.stringify({ type: 'createRoom', nickname: 'Old' }));
    expect(await oldResult).toMatchObject({ type: 'error', code: 'protocol-mismatch' });
    const mismatch = receive();
    raw.send(JSON.stringify({ type: 'hello', protocolVersion: 1 }));
    expect(await mismatch).toMatchObject({ type: 'error', code: 'protocol-mismatch' });
    for (const message of [
      { type: 'reconnect', roomCode: 'AB23', token: 'old-token' },
      { type: 'startGame' },
      { type: 'action', action: { type: 'all-in' } },
    ]) {
      const rejected = receive();
      raw.send(JSON.stringify(message));
      expect(await rejected).toMatchObject({ type: 'error', code: 'protocol-mismatch' });
    }
    expect(manager.roomCount()).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    raw.close();
  });
  it('rejects malformed JSON with a bad-message error', async () => {
    const manager = new RoomManager();
    wss = createWsServer(manager, 0);
    await new Promise<void>((resolve) => wss!.once('listening', resolve));
    const port = (wss.address() as AddressInfo).port;
    const raw = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => raw.once('open', () => resolve()));
    raw.send('not json');
    const error = await new Promise<{
      code: string;
    }>((resolve) => {
      raw.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(error.code).toBe('bad-message');
    // 坏消息不杀死会话：随后仍能正常建房
    const client = await TestClient.connect(port);
    client.send({ type: 'createRoom', nickname: 'Carol' });
    const joined = await client.waitFor('joined');
    expect(joined.roomCode).toMatch(/^[A-Z2-9]{4}$/);
    raw.close();
    client.close();
  });
});
