import { describe, expect, it, vi } from 'vitest';

import { EngineEvent, EngineSnapshot } from '../../assets/scripts/core/types';
import { OnlineSession, TableUpdate } from '../../assets/scripts/net/OnlineSession';
import { ClientMessage, RoomStateMessage, ServerMessage } from '../../assets/scripts/net/protocol';

class FakeClient {
  public readonly sent: ClientMessage[] = [];
  public onMessage: ((message: ServerMessage) => void) | null = null;
  public onClose: (() => void) | null = null;
  public connectCalls = 0;

  public connect(): Promise<void> {
    this.connectCalls += 1;
    return Promise.resolve();
  }

  public send(message: ClientMessage): void {
    this.sent.push(message);
  }

  public close(): void {}

  public emit(message: ServerMessage): void {
    this.onMessage?.(message);
  }
}

const ROOM: RoomStateMessage = {
  code: 'ABCD',
  phase: 'playing',
  hostId: 'p1',
  seats: [
    { playerId: 'p1', nickname: 'Alice', stack: 5000, connected: true },
    { playerId: 'p2', nickname: 'Bob', stack: 5000, connected: true },
    { playerId: 'p3', nickname: 'Cara', stack: 5000, connected: true },
  ],
};

function snapshot(partial: Partial<EngineSnapshot>): EngineSnapshot {
  return {
    handId: 1,
    street: 'preflop',
    actingPlayerId: 'p1',
    dealerPlayerId: 'p1',
    pot: 60,
    communityCards: [],
    legalActions: [{ type: 'fold' }, { type: 'call', amount: 40 }],
    players: [
      { id: 'p1', name: 'Alice', stack: 4960, folded: false, allIn: false, streetContribution: 40, totalContribution: 40 },
      { id: 'p2', name: 'Bob', stack: 4980, folded: false, allIn: false, streetContribution: 20, totalContribution: 20 },
      { id: 'p3', name: 'Cara', stack: 5000, folded: false, allIn: false, streetContribution: 0, totalContribution: 0 },
    ],
    ...partial,
  };
}

function createSession() {
  const client = new FakeClient();
  const updates: TableUpdate[] = [];
  const rooms: RoomStateMessage[] = [];
  const lost: string[] = [];
  const errors: string[] = [];
  const session = new OnlineSession(client as never, {
    playerId: 'p2',
    credentials: { roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
    handlers: {
      onTableUpdate: (update) => {
        updates.push(update);
        return Promise.resolve();
      },
      onRoomState: (room) => rooms.push(room),
      onSessionLost: (message) => lost.push(message),
      onError: (message) => errors.push(message),
    },
    reconnectDelayMs: 1,
    maxReconnectAttempts: 1,
  });
  return { client, session, updates, rooms, lost, errors };
}

describe('OnlineSession', () => {
  it('maps server seats to visual seats with the local player at the bottom', () => {
    const { client, session, rooms } = createSession();

    client.emit({ type: 'roomState', room: ROOM });

    expect(rooms).toEqual([ROOM]);
    expect(session.seatNames()).toEqual(new Map([
      ['player', 'Bob（你）'],
      ['ai-1', 'Cara'],
      ['ai-2', 'Alice'],
    ]));
  });

  it('synthesizes hole-card events on handStart plus yourHand', async () => {
    const { client, session, updates } = createSession();
    client.emit({ type: 'roomState', room: ROOM });

    client.emit({ type: 'handStart', handId: 1, dealerPlayerId: 'p1' });
    client.emit({ type: 'yourHand', handId: 1, cards: [{ suit: 'S', rank: 14 }, { suit: 'H', rank: 13 }] });
    await session.whenIdle();

    expect(updates).toHaveLength(1);
    const [update] = updates;
    expect(update.newHand).toBe(true);

    const own = update.events.filter((event) => event.type === 'hole-card-dealt' && event.playerId === 'player');
    expect(own).toEqual([
      { handId: 1, type: 'hole-card-dealt', playerId: 'player', card: { suit: 'S', rank: 14 }, faceDown: false },
      { handId: 1, type: 'hole-card-dealt', playerId: 'player', card: { suit: 'H', rank: 13 }, faceDown: false },
    ]);

    const others = update.events.filter((event) => event.type === 'hole-card-dealt' && event.playerId !== 'player');
    expect(others).toHaveLength(4);
    expect(others.every((event) => event.faceDown && !('card' in event && event.card))).toBe(true);
  });

  it('translates snapshot ids and synthesizes community reveals on stateSync', async () => {
    const { client, session, updates } = createSession();
    client.emit({ type: 'roomState', room: ROOM });
    client.emit({ type: 'handStart', handId: 1, dealerPlayerId: 'p1' });
    client.emit({ type: 'yourHand', handId: 1, cards: [{ suit: 'S', rank: 14 }, { suit: 'H', rank: 13 }] });

    client.emit({ type: 'stateSync', snapshot: snapshot({}) });
    client.emit({
      type: 'stateSync',
      snapshot: snapshot({
        street: 'flop',
        actingPlayerId: 'p2',
        communityCards: [{ suit: 'D', rank: 2 }, { suit: 'C', rank: 7 }, { suit: 'S', rank: 9 }],
      }),
    });
    await session.whenIdle();

    expect(updates).toHaveLength(3);

    const first = updates[1];
    expect(first.events).toHaveLength(0);
    expect(first.snapshot?.actingPlayerId).toBe('ai-2'); // p1 相对本地玩家 p2 是 ai-2
    expect(first.snapshot?.players.map((player) => player.id)).toEqual(['ai-2', 'player', 'ai-1']);

    const second = updates[2];
    expect(second.events.filter((event) => event.type === 'community-card-revealed')).toHaveLength(3);
    expect(second.snapshot?.actingPlayerId).toBe('player'); // 轮到本地玩家
  });

  it('translates actionTaken, showdown and handResult into engine events', async () => {
    const { client, session, updates } = createSession();
    client.emit({ type: 'roomState', room: ROOM });

    client.emit({ type: 'actionTaken', playerId: 'p1', action: { type: 'call', amount: 40 }, amount: 40 });
    client.emit({ type: 'showdown', handId: 1, reveals: [{ playerId: 'p3', cards: [{ suit: 'S', rank: 2 }, { suit: 'D', rank: 3 }], handName: '高牌' }] });
    client.emit({ type: 'handResult', handId: 1, payouts: [{ playerId: 'p3', amount: 60, handName: '高牌' }] });
    await session.whenIdle();

    expect((updates[0].events[0] as Extract<EngineEvent, { type: 'action-taken' }>).playerId).toBe('ai-2');
    expect((updates[1].events[0] as Extract<EngineEvent, { type: 'showdown' }>).playerId).toBe('ai-1');
    expect((updates[2].events[0] as Extract<EngineEvent, { type: 'pot-awarded' }>)).toMatchObject({ playerId: 'ai-1', amount: 60 });
  });

  it('sends actions to the server', () => {
    const { client, session } = createSession();
    session.sendAction({ type: 'raise', to: 160 });
    expect(client.sent).toEqual([{ type: 'action', action: { type: 'raise', to: 160 } }]);
  });

  it('reconnects with stored credentials when the socket closes', async () => {
    const { client } = createSession();
    client.onClose?.();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(client.connectCalls).toBe(1);
    expect(client.sent).toContainEqual({ type: 'reconnect', roomCode: 'ABCD', token: 'tok' });
  });

  it('keeps delivering updates after a table-update handler rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = new FakeClient();
    const updates: TableUpdate[] = [];
    let failNext = true;
    const session = new OnlineSession(client as never, {
      playerId: 'p2',
      credentials: { roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
      handlers: {
        onTableUpdate: (update) => {
          if (failNext) {
            failNext = false;
            return Promise.reject(new Error('boom'));
          }
          updates.push(update);
          return Promise.resolve();
        },
        onRoomState: () => undefined,
        onSessionLost: () => undefined,
      },
      reconnectDelayMs: 1,
      maxReconnectAttempts: 1,
    });

    client.emit({ type: 'roomState', room: ROOM });
    client.emit({ type: 'actionTaken', playerId: 'p1', action: { type: 'fold' }, amount: 0 });
    client.emit({ type: 'actionTaken', playerId: 'p3', action: { type: 'check' }, amount: 0 });
    await session.whenIdle();

    expect(updates).toHaveLength(1);
    expect((updates[0].events[0] as Extract<EngineEvent, { type: 'action-taken' }>).playerId).toBe('ai-1');
    consoleSpy.mockRestore();
  });

  it('does not reconnect after sendLeave during a pending reconnect', async () => {
    const { client, session } = createSession();
    client.onClose?.();
    session.sendLeave();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(client.sent).toContainEqual({ type: 'leaveRoom' });
    expect(client.sent.some((message) => message.type === 'reconnect')).toBe(false);
  });

  it('reports session loss when the server rejects the reconnect', async () => {
    const { client, lost, errors } = createSession();
    client.onClose?.();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(client.sent).toContainEqual({ type: 'reconnect', roomCode: 'ABCD', token: 'tok' });

    client.emit({ type: 'error', code: 'room-not-found', message: '无法恢复座位' });

    expect(lost).toEqual(['无法恢复座位']);
    expect(errors).toEqual([]);
  });

  it('forwards server errors outside reconnect to onError', () => {
    const { client, lost, errors } = createSession();

    client.emit({ type: 'error', code: 'not-your-turn', message: '还没轮到你行动' });

    expect(errors).toEqual(['还没轮到你行动']);
    expect(lost).toEqual([]);
  });

  it('keeps visual seat ids stable when a player leaves mid-hand', async () => {
    const { client, session, updates } = createSession();
    const room4: RoomStateMessage = {
      code: 'ABCD',
      phase: 'playing',
      hostId: 'p1',
      seats: [
        { playerId: 'p1', nickname: 'Alice', stack: 5000, connected: true },
        { playerId: 'p2', nickname: 'Bob', stack: 5000, connected: true },
        { playerId: 'p3', nickname: 'Cara', stack: 5000, connected: true },
        { playerId: 'p4', nickname: 'Dan', stack: 5000, connected: true },
      ],
    };

    client.emit({ type: 'roomState', room: room4 });
    expect(session.seatNames()).toEqual(new Map([
      ['player', 'Bob（你）'],
      ['ai-1', 'Cara'],
      ['ai-2', 'Dan'],
      ['ai-3', 'Alice'],
    ]));

    client.emit({
      type: 'roomState',
      room: { ...room4, seats: room4.seats.filter((seat) => seat.playerId !== 'p3') },
    });

    expect(session.seatNames()).toEqual(new Map([
      ['player', 'Bob（你）'],
      ['ai-2', 'Dan'],
      ['ai-3', 'Alice'],
    ]));

    client.emit({ type: 'actionTaken', playerId: 'p3', action: { type: 'fold' }, amount: 0 });
    await session.whenIdle();
    expect((updates[0].events[0] as Extract<EngineEvent, { type: 'action-taken' }>).playerId).toBe('ai-1');

    client.emit({
      type: 'roomState',
      room: {
        ...room4,
        seats: [
          room4.seats[0],
          room4.seats[1],
          room4.seats[3],
          { playerId: 'p5', nickname: 'Eve', stack: 5000, connected: true },
        ],
      },
    });

    expect(session.seatNames()).toEqual(new Map([
      ['player', 'Bob（你）'],
      ['ai-2', 'Dan'],
      ['ai-3', 'Alice'],
      ['ai-4', 'Eve'],
    ]));
  });

  it('resets hand state when a stateSync arrives for a missed hand', async () => {
    const { client, session, updates } = createSession();
    client.emit({ type: 'roomState', room: ROOM });
    client.emit({ type: 'handStart', handId: 1, dealerPlayerId: 'p1' });
    client.emit({ type: 'yourHand', handId: 1, cards: [{ suit: 'S', rank: 14 }, { suit: 'H', rank: 13 }] });

    client.emit({
      type: 'stateSync',
      snapshot: snapshot({
        handId: 2,
        street: 'flop',
        actingPlayerId: 'p2',
        communityCards: [{ suit: 'D', rank: 2 }, { suit: 'C', rank: 7 }, { suit: 'S', rank: 9 }],
      }),
    });
    await session.whenIdle();

    expect(updates).toHaveLength(2);
    const update = updates[1];
    expect(update.newHand).toBe(true);
    expect(update.events.filter((event) => event.type === 'community-card-revealed')).toHaveLength(3);
    expect(update.snapshot?.handId).toBe(2);
  });

  it('ignores an empty yourHand dealt to a zero-chip seat', async () => {
    const { client, session, updates } = createSession();
    client.emit({ type: 'roomState', room: ROOM });
    client.emit({ type: 'handStart', handId: 1, dealerPlayerId: 'p1' });
    client.emit({ type: 'yourHand', handId: 1, cards: [] });
    await session.whenIdle();

    expect(updates).toHaveLength(0);
  });

  it('applies a primed room so the first handStart maps opponents before any roomState', async () => {
    const { client, session, updates, rooms } = createSession();

    session.primeRoom(ROOM);
    expect(session.seatNames().size).toBe(3);
    expect(rooms).toEqual([]);

    client.emit({ type: 'handStart', handId: 1, dealerPlayerId: 'p1' });
    client.emit({ type: 'stateSync', snapshot: snapshot({}) });
    await session.whenIdle();

    expect(updates).toHaveLength(1);
    const dealt = updates[0].events.filter((event) => event.type === 'hole-card-dealt');
    expect(dealt).toHaveLength(4);
    expect(dealt.every((event) => event.faceDown && event.playerId !== 'player')).toBe(true);
  });

  it('backs off exponentially and reports session loss after exhausting attempts', async () => {
    const client = new FakeClient();
    client.connect = () => {
      client.connectCalls += 1;
      return Promise.reject(new Error('nope'));
    };
    const lost: string[] = [];
    void new OnlineSession(client as never, {
      playerId: 'p2',
      credentials: { roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
      handlers: {
        onTableUpdate: () => Promise.resolve(),
        onRoomState: () => undefined,
        onSessionLost: (message) => lost.push(message),
      },
      reconnectDelayMs: 1,
      maxReconnectAttempts: 3,
    });

    client.onClose?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(client.connectCalls).toBe(3);
    expect(lost).toEqual(['与服务器断开连接，请重新加入房间']);
  });

  it('ends the session without reconnecting when the seat is taken over', async () => {
    const { client, lost, errors } = createSession();

    client.emit({ type: 'error', code: 'session-taken-over', message: '该座位已在别处登录' });

    expect(lost).toEqual(['该座位已在别处登录']);
    expect(errors).toEqual([]);

    client.onClose?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.connectCalls).toBe(0);
  });
});
