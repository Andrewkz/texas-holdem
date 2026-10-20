import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

import { EngineEvent, EngineSnapshot } from '../../assets/scripts/core/types';
import { OnlineCommands } from '../../assets/scripts/net/OnlineCommands';
import { OnlineSession, TableUpdate } from '../../assets/scripts/net/OnlineSession';
import { clockwiseSeatIdsFrom } from '../../assets/scripts/core/SeatOrder';
import { getPokerSeatLayout } from '../../assets/scripts/ui/PokerUiTheme';
import { TurnCountdown } from '../../assets/scripts/ui/TurnCountdown';
import { ClientMessage, RoomStateMessage, ServerMessage } from '../../assets/scripts/net/protocol';

class FakeClient {
  public readonly sent: ClientMessage[] = [];
  public onMessage: ((message: ServerMessage) => void) | null = null;
  public onClose: (() => void) | null = null;
  public connectCalls = 0;
  private listeners=new Set<(message:ServerMessage)=>void>();
  public subscribe(listener:(message:ServerMessage)=>void):()=>void {this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  public waitForAdmission(ms=10000):Promise<any>{return this.waitForJoined(ms);}
  private joinedWait: { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  public waitForJoined(timeoutMs = 10000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.joinedWait = null; reject(new Error('座位确认超时')); }, timeoutMs);
      this.joinedWait = { resolve, reject, timer };
    });
  }

  public connect(): Promise<void> {
    this.connectCalls += 1;
    return Promise.resolve();
  }

  public send(message: ClientMessage): void {
    this.sent.push(message);
  }

  public close(): void {
    if (this.joinedWait) { clearTimeout(this.joinedWait.timer); this.joinedWait.reject(new Error('closed')); this.joinedWait = null; }
  }

  public emit(message: ServerMessage): void {
    if (message.type === 'joined' && this.joinedWait) {
      clearTimeout(this.joinedWait.timer); this.joinedWait.resolve(message); this.joinedWait = null;
    }
    for(const listener of Array.from(this.listeners))listener(message);
    this.onMessage?.(message);
  }
}

const ROOM: RoomStateMessage = {
  code: 'ABCD',
  session:{sessionId:'s',tableEpoch:'epoch',lifecycle:'active',checkpointVersion:0,allOfflineDeadline:null},
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

function createSession(playerId = 'p2') {
  const client = new FakeClient();
  const updates: TableUpdate[] = [];
  const rooms: RoomStateMessage[] = [];
  const lost: string[] = [];
  const errors: string[] = [];
  const session = new OnlineSession(client as never, {
    playerId,
    credentials: { sessionId:'s',playerId,autoResume:true,roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
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
      ['ai-5', 'Cara'],
      ['ai-2', 'Alice'],
    ]));
  });

  it('synthesizes hole-card events on handStart plus yourHand', async () => {
    const { client, session, updates } = createSession();
    client.emit({ type: 'roomState', room: ROOM });

    client.emit({ type: 'handStart', sessionId:'s',tableEpoch:'epoch', handId: 1, dealerPlayerId: 'p1', participantIds: ['p1', 'p2', 'p3'] });
    client.emit({ type: 'yourHand', sessionId:'s',tableEpoch:'epoch', handId: 1, cards: [{ suit: 'S', rank: 14 }, { suit: 'H', rank: 13 }] });
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
    client.emit({ type: 'handStart', sessionId:'s',tableEpoch:'epoch', handId: 1, dealerPlayerId: 'p1', participantIds: ['p1', 'p2', 'p3'] });
    client.emit({ type: 'yourHand', sessionId:'s',tableEpoch:'epoch', handId: 1, cards: [{ suit: 'S', rank: 14 }, { suit: 'H', rank: 13 }] });

    client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({}) });
    client.emit({
      type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand',
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
    expect(first.snapshot?.actingPlayerId).toBe('ai-2'); // p1 is the second clockwise seat after local player p2
    expect(first.snapshot?.players.map((player) => player.id)).toEqual(['ai-2', 'player', 'ai-5']);

    const second = updates[2];
    expect(second.events.filter((event) => event.type === 'community-card-revealed')).toHaveLength(3);
    expect(second.snapshot?.actingPlayerId).toBe('player'); // 轮到本地玩家
  });

  it('translates actionTaken, showdown and handResult into engine events', async () => {
    const { client, session, updates } = createSession();
    client.emit({ type: 'roomState', room: ROOM });

    client.emit({ type: 'actionTaken', sessionId:'s',tableEpoch:'epoch',handId:1, playerId: 'p1', action: { type: 'call', amount: 40 }, amount: 40 });
    client.emit({ type: 'showdown', sessionId:'s',tableEpoch:'epoch', handId: 1, reveals: [{ playerId: 'p3', cards: [{ suit: 'S', rank: 2 }, { suit: 'D', rank: 3 }], handName: '高牌' }] });
    client.emit({ type: 'handResult', sessionId:'s',tableEpoch:'epoch', handId: 1, payouts: [{ playerId: 'p3', amount: 60, handName: '高牌' }] });
    await session.whenIdle();

    expect((updates[0].events[0] as Extract<EngineEvent, { type: 'action-taken' }>).playerId).toBe('ai-2');
    expect((updates[1].events[0] as Extract<EngineEvent, { type: 'showdown' }>).playerId).toBe('ai-5');
    expect((updates[2].events[0] as Extract<EngineEvent, { type: 'pot-awarded' }>)).toMatchObject({ playerId: 'ai-5', amount: 60 });
  });

  it('sends actions only after an authoritative snapshot has rendered', async () => {
    const { client, session } = createSession();
    client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({ actingPlayerId: 'p2', legalActions: [{ type: 'raise', minTo: 80, maxTo: 5000 }] }) });
    await session.whenIdle();
    session.sendAction({ type: 'raise', to: 160 });
    expect(client.sent).toEqual([{ type: 'action', sessionId:'s',tableEpoch:'epoch',handId:1, action: { type: 'raise', to: 160 } }]);
  });

  it('reconnects with stored credentials when the socket closes', async () => {
    const { client } = createSession();
    client.onClose?.();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(client.connectCalls).toBe(1);
    expect(client.sent).toContainEqual({ type: 'reconnect', sessionId:'s', token: 'tok' });
  });

  it('keeps delivering updates after a table-update handler rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = new FakeClient();
    const updates: TableUpdate[] = [];
    let failNext = true;
    const session = new OnlineSession(client as never, {
      playerId: 'p2',
      credentials: { sessionId:'s',playerId:'p2',autoResume:true,roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
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
    client.emit({ type: 'actionTaken', sessionId:'s',tableEpoch:'epoch',handId:1, playerId: 'p1', action: { type: 'fold' }, amount: 0 });
    client.emit({ type: 'actionTaken', sessionId:'s',tableEpoch:'epoch',handId:1, playerId: 'p3', action: { type: 'check' }, amount: 0 });
    await session.whenIdle();

    expect(updates).toHaveLength(1);
    expect((updates[0].events[0] as Extract<EngineEvent, { type: 'action-taken' }>).playerId).toBe('ai-5');
    consoleSpy.mockRestore();
  });

  it('does not reconnect after sendLeave during a pending reconnect', async () => {
    const { client, session } = createSession();
    client.onClose?.();
    session.sendLeave();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(client.sent).toContainEqual(expect.objectContaining({ type: 'leaveRoom',sessionId:'s',requestId:expect.any(String) }));
    session.dispose();
    expect(client.sent.some((message) => message.type === 'reconnect')).toBe(false);
  });

  it('reports session loss when the server rejects the reconnect', async () => {
    const { client, lost, errors } = createSession();
    client.onClose?.();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(client.sent).toContainEqual({ type: 'reconnect', sessionId:'s', token: 'tok' });

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
  session:{sessionId:'s',tableEpoch:'epoch',lifecycle:'active',checkpointVersion:0,allOfflineDeadline:null},
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
      ['ai-5', 'Cara'],
      ['ai-2', 'Dan'],
      ['ai-1', 'Alice'],
    ]));

    client.emit({
      type: 'roomState',
      room: { ...room4, seats: room4.seats.filter((seat) => seat.playerId !== 'p3') },
    });

    expect(session.seatNames()).toEqual(new Map([
      ['player', 'Bob（你）'],
      ['ai-2', 'Dan'],
      ['ai-1', 'Alice'],
    ]));

    client.emit({ type: 'actionTaken', sessionId:'s',tableEpoch:'epoch',handId:1, playerId: 'p3', action: { type: 'fold' }, amount: 0 });
    await session.whenIdle();
    expect((updates[0].events[0] as Extract<EngineEvent, { type: 'action-taken' }>).playerId).toBe('ai-5');

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
      ['ai-1', 'Alice'],
      ['ai-3', 'Eve'],
    ]));
  });

  it('resets hand state when a stateSync arrives for a missed hand', async () => {
    const { client, session, updates } = createSession();
    client.emit({ type: 'roomState', room: ROOM });
    client.emit({ type: 'handStart', sessionId:'s',tableEpoch:'epoch', handId: 1, dealerPlayerId: 'p1', participantIds: ['p1', 'p2', 'p3'] });
    client.emit({ type: 'yourHand', sessionId:'s',tableEpoch:'epoch', handId: 1, cards: [{ suit: 'S', rank: 14 }, { suit: 'H', rank: 13 }] });

    client.emit({
      type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand',
      snapshot: snapshot({
        handId: 2,
        street: 'flop',
        actingPlayerId: 'p2',
        communityCards: [{ suit: 'D', rank: 2 }, { suit: 'C', rank: 7 }, { suit: 'S', rank: 9 }],
      }),
    });
    await session.whenIdle();

    expect(updates).toHaveLength(1); // The missed hand invalidates the unrendered previous-hand queue.
    const update = updates[0];
    expect(update.newHand).toBe(true);
    expect(update.events.filter((event) => event.type === 'community-card-revealed')).toHaveLength(3);
    expect(update.snapshot?.handId).toBe(2);
  });

  it('ignores an empty yourHand dealt to a zero-chip seat', async () => {
    const { client, session, updates } = createSession();
    client.emit({ type: 'roomState', room: ROOM });
    client.emit({ type: 'handStart', sessionId:'s',tableEpoch:'epoch', handId: 1, dealerPlayerId: 'p1', participantIds: ['p1', 'p2', 'p3'] });
    client.emit({ type: 'yourHand', sessionId:'s',tableEpoch:'epoch', handId: 1, cards: [] });
    await session.whenIdle();

    expect(updates).toHaveLength(0);
  });

  it('applies a primed room so the first handStart maps opponents before any roomState', async () => {
    const { client, session, updates, rooms } = createSession();

    session.primeRoom(ROOM);
    expect(session.seatNames().size).toBe(3);
    expect(rooms).toEqual([]);

    client.emit({ type: 'handStart', sessionId:'s',tableEpoch:'epoch', handId: 1, dealerPlayerId: 'p1', participantIds: ['p1', 'p2', 'p3'] });
    client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({}) });
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
      credentials: { sessionId:'s',playerId:'p2',autoResume:true,roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
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

describe('OnlineSession bounded recovery and authoritative rendering', () => {
  afterEach(() => vi.useRealTimers());
  function recovery(options: { reconnectBudgetMs?: number; joinedTimeoutMs?: number; onTableUpdate?: (update: TableUpdate) => Promise<void> } = {}) {
    const client = new FakeClient();
    const lost: string[] = [];
    const statuses: string[] = [];
    const updates: TableUpdate[] = [];
    const session = new OnlineSession(client as never, {
      playerId: 'p2', credentials: { sessionId:'s',playerId:'p2',autoResume:true,roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
      reconnectDelayMs: 2, maxReconnectAttempts: 3, reconnectBudgetMs: options.reconnectBudgetMs ?? 100,
      joinedTimeoutMs: options.joinedTimeoutMs ?? 5,
      handlers: { onRoomState: () => undefined, onSessionLost: (message) => lost.push(message),
        onConnectionStatus: (status) => statuses.push(status),
        onTableUpdate: options.onTableUpdate ?? (async (update) => { updates.push(update); }) },
    });
    session.primeRoom(ROOM);
    return { client, session, lost, statuses, updates };
  }
  const joined = { type: 'joined' as const,sessionId:'s', roomCode: 'ABCD', playerId: 'p2', token: 'tok', room: ROOM };
  it('retries missing joined responses finitely without silently joining', async () => {
    vi.useFakeTimers();
    const { client, lost, session } = recovery();
    client.onClose?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.connectCalls).toBe(3);
    expect(lost).toHaveLength(1);
    expect(client.sent.every((message) => message.type === 'reconnect')).toBe(true);
    session.dispose();
  });
  it('stops at the total budget even if one negotiated connection never settles', async () => {
    vi.useFakeTimers();
    const { client, lost } = recovery({ reconnectBudgetMs: 12 });
    client.connect = () => { client.connectCalls += 1; return new Promise(() => undefined); };
    client.onClose?.();
    await vi.advanceTimersByTimeAsync(12);
    expect(lost).toHaveLength(1);
    expect(client.connectCalls).toBe(1);
  });
  it('keeps actions blocked until the fresh snapshot finishes rendering', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const { client, session, statuses } = recovery({ onTableUpdate: () => new Promise((resolve) => { finish = resolve; }) });
    client.onClose?.();
    await vi.advanceTimersByTimeAsync(2);
    client.emit(joined);
    client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({ actingPlayerId: 'p2' }) });
    await Promise.resolve();
    expect(statuses).not.toContain('connected');
    session.sendAction({ type: 'fold' });
    expect(client.sent.some((message) => message.type === 'action')).toBe(false);
    finish();
    await session.whenIdle();
    expect(statuses.at(-1)).toBe('connected');
    session.sendAction({ type: 'fold' });
    expect(client.sent.at(-1)).toEqual({ type: 'action', sessionId:'s',tableEpoch:'epoch',handId:1, action: { type: 'fold' } });
    session.dispose();
  });
  it('invalidates blocked old renders and lets a fresh recovery snapshot bypass the old queue', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let first = true;
    const applied: number[] = [];
    const { client, session } = recovery({ onTableUpdate: async (update) => {
      if (first) { first = false; await new Promise<void>((resolve) => { release = resolve; }); }
      if (update.isCurrent() && update.snapshot) applied.push(update.snapshot.pot);
    } });
    client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({ pot: 60 }) });
    await Promise.resolve();
    client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({ pot: 80 }) });
    client.onClose?.();
    await vi.advanceTimersByTimeAsync(2);
    client.emit(joined);
    client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({ pot: 120 }) });
    await session.whenIdle();
    release();
    await Promise.resolve(); await Promise.resolve();
    expect(applied).toEqual([120]);
    session.dispose();
  });
  it('uses actual dealt participants including departed identities and reserves no self slot for a waiter', async () => {
    const { client, session, updates } = recovery();
    const ids = ['p1', 'p3', 'p4', 'p5', 'p6', 'departed'];
    client.emit({ type: 'handStart', sessionId:'s',tableEpoch:'epoch', handId: 1, dealerPlayerId: 'p1', participantIds: ids });
    client.emit({ type: 'yourHand', sessionId:'s',tableEpoch:'epoch', handId: 1, cards: [{ suit: 'S', rank: 14 }, { suit: 'H', rank: 13 }] });
    client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'waiting-next-hand', snapshot: snapshot({
      legalActions: [], players: ids.map((id) => ({ id, name: id === 'departed' ? 'Old friend' : id, stack: 0, folded: false, allIn: true, streetContribution: 20, totalContribution: 20 })),
    }) });
    await session.whenIdle();
    const cards = updates.flatMap((update) => update.events).filter((event) => event.type === 'hole-card-dealt');
    expect(cards).toHaveLength(12);
    expect(cards.every((card) => card.faceDown)).toBe(true);
    expect(new Set(updates.at(-1)?.snapshot?.players.map((player) => player.id)).size).toBe(6);
    expect([...session.seatNames().values()]).toContain('Old friend');
    expect([...session.seatNames().values()]).not.toContain('Bob（你）');
    expect(updates.at(-1)?.participation).toBe('waiting-next-hand');
    session.dispose();
  });
  it('deduplicates repeated hand replay and keeps exactly two own cards', async () => {
    const { client, session, updates } = recovery();
    for (let repeat = 0; repeat < 2; repeat += 1) {
      client.emit(joined);
      client.emit({ type: 'handStart', sessionId:'s',tableEpoch:'epoch', handId: 1, dealerPlayerId: 'p1', participantIds: ['p1', 'p2', 'p3'] });
      client.emit({ type: 'yourHand', sessionId:'s',tableEpoch:'epoch', handId: 1, cards: [{ suit: 'S', rank: 14 }, { suit: 'H', rank: 13 }] });
      client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({}) });
    }
    await session.whenIdle();
    expect(updates.flatMap((update) => update.events).filter((event) => event.type === 'hole-card-dealt' && event.playerId === 'player')).toHaveLength(2);
    session.dispose();
  });
  it('dispose prevents late joined, callbacks and reconnect actions', async () => {
    vi.useFakeTimers();
    const { client, session, statuses, updates } = recovery();
    client.onClose?.();
    await vi.advanceTimersByTimeAsync(2);
    session.dispose();
    client.emit(joined);
    client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({}) });
    await vi.advanceTimersByTimeAsync(100);
    expect(updates).toEqual([]);
    expect(statuses).not.toContain('connected');
  });
});

describe('OnlineSession recovery replay', () => {
  afterEach(() => vi.useRealTimers());
  it('rebuilds exactly two own cards when the same hand is recovered into a cleared view', async () => {
    vi.useFakeTimers();
    const { client, session, updates } = createSession();
    session.primeRoom(ROOM);
    const replay = () => {
      client.emit({ type: 'handStart', sessionId:'s',tableEpoch:'epoch', handId: 1, dealerPlayerId: 'p1', participantIds: ['p1', 'p2', 'p3'] });
      client.emit({ type: 'yourHand', sessionId:'s',tableEpoch:'epoch', handId: 1, cards: [{ suit: 'S', rank: 14 }, { suit: 'H', rank: 13 }] });
      client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({}) });
    };
    replay();
    await session.whenIdle();
    updates.length = 0;
    client.onClose?.();
    await vi.advanceTimersByTimeAsync(1);
    client.emit({ type: 'joined', sessionId:'s', roomCode: 'ABCD', playerId: 'p2', token: 'tok', room: ROOM });
    replay();
    await session.whenIdle();
    const own = updates.flatMap((update) => update.events).filter((event) => event.type === 'hole-card-dealt' && event.playerId === 'player');
    expect(own).toHaveLength(2);
    expect(updates[0].newHand).toBe(true);
    session.dispose();
  });
});

describe('OnlineSession reconnect races', () => {
  afterEach(() => vi.useRealTimers());
  it('continues recovering if the transport closes immediately after joined', async () => {
    vi.useFakeTimers();
    const { client, session, lost } = createSession();
    client.onClose?.();
    await vi.advanceTimersByTimeAsync(1);
    client.emit({ type: 'joined', sessionId:'s', roomCode: 'ABCD', playerId: 'p2', token: 'tok', room: ROOM });
    client.onClose?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(lost).toHaveLength(1);
    session.dispose();
  });
  it('does not enable actions from an older rendered snapshot while the latest snapshot is still pending', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let count = 0;
    const client = new FakeClient();
    const session = new OnlineSession(client as never, {
      playerId: 'p2', credentials: { sessionId:'s',playerId:'p2',autoResume:true,roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
      handlers: { onRoomState: () => undefined, onSessionLost: () => undefined, onTableUpdate: () => new Promise((resolve) => {
        count += 1;
        if (count === 1) releaseFirst = resolve; else releaseSecond = resolve;
      }) },
    });
    session.primeRoom(ROOM);
    client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({ actingPlayerId: 'p2' }) });
    await Promise.resolve();
    client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({ actingPlayerId: 'p1', legalActions: [] }) });
    releaseFirst();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(session.canAct()).toBe(false);
    releaseSecond();
    await session.whenIdle();
    expect(session.canAct()).toBe(false);
    session.dispose();
  });
});

describe('OnlineSession UI lifecycle integration', () => {
  it('applies a primed lobby before marking it connected and accepting host start', () => {
    const client = new FakeClient();
    const observed: string[] = [];
    const session = new OnlineSession(client as never, {
      playerId: 'p2', credentials: { sessionId:'s',playerId:'p2',autoResume:true,roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
      handlers: {
        onRoomState: (room) => observed.push(`room:${room.phase}`),
        onConnectionStatus: (status) => observed.push(status),
        onTableUpdate: async () => undefined, onSessionLost: () => undefined,
      },
    });
    session.primeRoom({ ...ROOM, phase: 'lobby', hostId: 'p2' });
    session.sendStartGame();
    expect(observed).toEqual(['room:lobby', 'connected']);
    expect(client.sent).toEqual([{ type: 'startGame',sessionId:'s' }]);
    session.dispose();
  });
  it('does not mark a primed playing room connected before its authoritative table is rendered', () => {
    const client = new FakeClient();
    const observed: string[] = [];
    const session = new OnlineSession(client as never, {
      playerId: 'p2', credentials: { sessionId:'s',playerId:'p2',autoResume:true,roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
      handlers: { onRoomState: (room) => observed.push(`room:${room.phase}`), onConnectionStatus: (status) => observed.push(status),
        onTableUpdate: async () => undefined, onSessionLost: () => undefined },
    });
    session.primeRoom(ROOM);
    expect(observed).not.toContain('connected');
    expect(session.canAct()).toBe(false);
    session.dispose();
  });
  it('notifies the UI after every latest authoritative commit with the newly valid permissions', async () => {
    const client = new FakeClient();
    const permissionsAtNotify: boolean[] = [];
    let renders = 0;
    const session = new OnlineSession(client as never, {
      playerId: 'p2', credentials: { sessionId:'s',playerId:'p2',autoResume:true,roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
      handlers: { onRoomState: () => undefined, onSessionLost: () => undefined,
        onTableUpdate: async () => { renders += 1; expect(session.canAct()).toBe(false); },
        onConnectionStatus: (status) => { if (status === 'connected') permissionsAtNotify.push(session.canAct()); },
      },
    });
    session.primeRoom(ROOM);
    client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({ actingPlayerId: 'p1', legalActions: [] }) });
    await session.whenIdle();
    client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({ actingPlayerId: 'p2' }) });
    await session.whenIdle();
    expect(renders).toBe(2);
    expect(permissionsAtNotify).toEqual([false, true]);
    session.dispose();
  });
});

describe('OnlineSession hand-scoped rendering', () => {
  it('invalidates a blocked old hand and renders the next hand without waiting for its old queue', async () => {
    let release!: () => void;
    let blockFirst = true;
    const applied: { handId: number; events: EngineEvent[] }[] = [];
    const client = new FakeClient();
    const invalidated: boolean[] = [];
    const session = new OnlineSession(client as never, {
      playerId: 'p2', credentials: { sessionId:'s',playerId:'p2',autoResume:true,roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
      handlers: { onRoomState: () => undefined, onSessionLost: () => undefined, onInvalidate: () => invalidated.push(true),
        onTableUpdate: async (update) => {
          if (blockFirst) { blockFirst = false; await new Promise<void>((resolve) => { release = resolve; }); }
          if (update.isCurrent()) applied.push({ handId: update.snapshot?.handId ?? update.events[0]?.handId ?? 0, events: update.events });
        },
      },
    });
    session.primeRoom(ROOM);
    client.emit({ type: 'handStart', sessionId:'s',tableEpoch:'epoch', handId: 1, dealerPlayerId: 'p1', participantIds: ['p1', 'p2', 'p3'] });
    client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({}) });
    await Promise.resolve();
    client.emit({ type: 'handResult', sessionId:'s',tableEpoch:'epoch', handId: 1, payouts: [{ playerId: 'p1', amount: 60, handName: 'old winner' }] });
    client.emit({ type: 'handStart', sessionId:'s',tableEpoch:'epoch', handId: 2, dealerPlayerId: 'p1', participantIds: ['p1', 'p2', 'p3'] });
    client.emit({ type: 'yourHand', sessionId:'s',tableEpoch:'epoch', handId: 2, cards: [{ suit: 'D', rank: 2 }, { suit: 'C', rank: 3 }] });
    client.emit({ type: 'stateSync', sessionId:'s',tableEpoch:'epoch', participation: 'playing-hand', snapshot: snapshot({ handId: 2 }) });
    await session.whenIdle();
    release();
    await Promise.resolve(); await Promise.resolve();
    expect(applied.every((update) => update.handId === 2)).toBe(true);
    expect(applied.flatMap((update) => update.events).some((event) => event.type === 'pot-awarded')).toBe(false);
    expect(applied.flatMap((update) => update.events).filter((event) => event.type === 'hole-card-dealt' && event.playerId === 'player')).toHaveLength(2);
    expect(invalidated.length).toBeGreaterThanOrEqual(1);
    session.dispose();
  });
});


describe('OnlineSession compiled iterable compatibility', () => {
  afterEach(() => vi.useRealTimers());
  it('clears a pending reconnect backoff when disposed in a target without iterator spread helpers', async () => {
    vi.useFakeTimers();
    const source = readFileSync(new URL('../../assets/scripts/net/OnlineSession.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.CommonJS, downlevelIteration: false } }).outputText;
    const exported: { OnlineSession?: typeof OnlineSession } = {};
    new Function('exports','require', compiled)(exported,(name:string)=>name.includes('TurnCountdown') ? { TurnCountdown } : name.includes('SeatOrder') ? { clockwiseSeatIdsFrom } : { OnlineCommands });
    const client = new FakeClient();
    const session = new exported.OnlineSession!(client as never, {
      playerId: 'p2', credentials: { sessionId:'s',playerId:'p2',autoResume:true,roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
      handlers: { onRoomState: () => undefined, onSessionLost: () => undefined, onTableUpdate: async () => undefined },
    });
    client.onClose?.();
    expect(vi.getTimerCount()).toBe(1);
    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.connectCalls).toBe(0);
  });
});


describe('v3 session authority and terminal lifecycle',()=>{
 it('rejects late old-hand events and prior runtime room states after rollback',async()=>{
  const {client,session,updates}=createSession();session.primeRoom(ROOM);
  client.emit({type:'stateSync',sessionId:'s',tableEpoch:'epoch',participation:'playing-hand',snapshot:snapshot({handId:2})});await session.whenIdle();
  updates.length=0;
  client.emit({type:'showdown',sessionId:'s',tableEpoch:'epoch',handId:1,reveals:[{playerId:'p1',cards:[{suit:'S',rank:14},{suit:'S',rank:13}],handName:'old'}]});
  await session.whenIdle();expect(updates).toHaveLength(0);
  client.emit({type:'recoveryNotice',notice:{sessionId:'s',tableEpoch:'new',checkpointVersion:1,rolledBackHandId:2,reason:'server-restart'}});
  client.emit({type:'roomState',room:{...ROOM,phase:'lobby',session:{...ROOM.session,tableEpoch:'new'}}});
  client.emit({type:'roomState',room:ROOM});
  client.emit({type:'stateSync',sessionId:'s',tableEpoch:'epoch',participation:'playing-hand',snapshot:snapshot({actingPlayerId:'p2'})});
  await session.whenIdle();expect(session.canAct()).toBe(false);session.dispose();
 });
 it('invalidates blocked animation before ledger, recovery and final callbacks and never reconnects after ended',async()=>{
  const client=new FakeClient();const seen:string[]=[];let release!:()=>void;
  const session=new OnlineSession(client as never,{playerId:'p2',credentials:{sessionId:'s',playerId:'p2',roomCode:'ABCD',token:'tok',nickname:'B',serverUrl:'ws://x'},handlers:{
   onRoomState:()=>{},onSessionLost:()=>{},onInvalidate:()=>seen.push('invalidate'),onTableUpdate:async update=>{await new Promise<void>(resolve=>release=resolve);if(update.isCurrent())seen.push('stale-render');},
   onLedger:()=>seen.push('ledger'),onRecoveryNotice:()=>seen.push('recovery'),onSessionEnded:()=>seen.push('ended')
  }});session.primeRoom(ROOM);
  client.emit({type:'stateSync',sessionId:'s',tableEpoch:'epoch',participation:'playing-hand',snapshot:snapshot({})});await Promise.resolve();
  client.emit({type:'ledgerSync',ledger:{sessionId:'s',committedHandId:0,rows:[]}});
  client.emit({type:'recoveryNotice',notice:{sessionId:'s',tableEpoch:'new',checkpointVersion:1,rolledBackHandId:1,reason:'server-restart'}});
  client.emit({type:'sessionEnded',settlement:{sessionId:'s',shareId:'share',endedAt:1,expiresAt:2592000001,reason:'host-ended',recoveryNotice:null,rows:[]}});
  release();await Promise.resolve();client.onClose?.();
  expect(seen).not.toContain('stale-render');expect(seen).toContain('ledger');expect(seen.indexOf('ended')).toBeGreaterThan(seen.indexOf('recovery'));expect(session.canAct()).toBe(false);expect(client.connectCalls).toBe(0);
 });
});

describe('v3 bounded leave and storage-failure authority',()=>{
 afterEach(()=>vi.useRealTimers());
 it('retains the same proof and returns unknown leave acknowledgement finitely',async()=>{
  vi.useFakeTimers();const client=new FakeClient();const credentials={sessionId:'s',playerId:'p2',roomCode:'ABCD',token:'proof',nickname:'B',serverUrl:'ws://x'};
  const session=new OnlineSession(client as never,{playerId:'p2',credentials,commandTimeoutMs:10,handlers:{onRoomState:()=>{},onSessionLost:()=>{},onTableUpdate:async()=>{}}});
  session.primeRoom(ROOM);const pending=session.sendLeave('leave-once');await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toMatchObject({requestId:'leave-once',status:'pending'});expect(credentials.token).toBe('proof');expect(client.sent).toEqual([{type:'leaveRoom',sessionId:'s',requestId:'leave-once'}]);client.onClose?.();expect(client.connectCalls).toBe(0);
 });
 it('blocks prior action authority after storage failure until new authoritative state',async()=>{
  const {client,session}=createSession();session.primeRoom(ROOM);
  client.emit({type:'stateSync',sessionId:'s',tableEpoch:'epoch',participation:'playing-hand',snapshot:snapshot({actingPlayerId:'p2'})});await session.whenIdle();expect(session.canAct()).toBe(true);
  client.emit({type:'error',code:'storage-failed',message:'保存失败'});expect(session.canAct()).toBe(false);session.sendAction({type:'fold'});expect(client.sent).toHaveLength(0);session.dispose();
 });
});

describe('v3 lobby rollback admission',()=>{
 it('keeps a recovered lobby connected when recoveryNotice follows its authoritative room state',()=>{
  const client=new FakeClient();const statuses:string[]=[];const notices:any[]=[];
  const session=new OnlineSession(client as never,{playerId:'p2',credentials:{sessionId:'s',playerId:'p2',roomCode:'ABCD',token:'tok',nickname:'B',serverUrl:'ws://x'},handlers:{onRoomState:()=>{},onSessionLost:()=>{},onTableUpdate:async()=>{},onConnectionStatus:status=>statuses.push(status),onRecoveryNotice:notice=>notices.push(notice)}});
  const lobby={...ROOM,phase:'lobby' as const,session:{...ROOM.session,tableEpoch:'new'}};
  session.primeRoom(lobby);
  client.emit({type:'recoveryNotice',notice:{sessionId:'s',tableEpoch:'new',checkpointVersion:1,rolledBackHandId:1,reason:'server-restart'}});
  expect(statuses.at(-1)).toBe('connected');expect(notices).toHaveLength(1);session.sendStartGame();expect(client.sent.at(-1)).toEqual({type:'startGame',sessionId:'s'});expect(session.canAct()).toBe(false);session.dispose();
 });
});

describe('OnlineSession server turn countdown', () => {
  function timedSession(onTableUpdate: (update: TableUpdate) => Promise<void> = async () => {}) {
    let now = 100;
    const client = new FakeClient();
    const session = new OnlineSession(client as never, {
      playerId: 'p2', credentials: { sessionId: 's', playerId: 'p2', roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
      monotonicNow: () => now,
      handlers: { onRoomState: () => {}, onSessionLost: () => {}, onTableUpdate },
    });
    session.primeRoom(ROOM);
    const sync = (timer: any = { playerId: 'p1', deadlineAt: 40000, serverNow: 10000, durationMs: 30000 }, partial: Partial<EngineSnapshot> = {}) => {
      client.emit({ type: 'stateSync', sessionId: 's', tableEpoch: 'epoch', participation: 'playing-hand', snapshot: snapshot(partial), turnTimer: timer } as ServerMessage);
    };
    return { client, session, sync, advance: (ms: number) => { now += ms; } };
  }

  it('updates before blocked animations, maps the acting seat and never extends the same deadline', async () => {
    let release!: () => void;
    const { client, session, sync, advance } = timedSession(() => new Promise<void>(resolve => { release = resolve; }));
    sync();
    expect(session.getTurnCountdown()).toEqual({ playerId: 'ai-2', handId: 1, deadlineAt: 40000, seconds: 30, fraction: 1, urgent: false });
    await Promise.resolve();
    advance(12000);
    sync();
    expect(session.getTurnCountdown()?.seconds).toBe(18);
    expect(session.canAct()).toBe(false);
    advance(20000);
    expect(session.getTurnCountdown()?.seconds).toBe(0);
    expect(client.sent).toHaveLength(0);
    session.dispose();
    release();
  });

  it('hides old messages without timer, actor mismatches, completed hands and explicit no timer', () => {
    const { client, session, sync } = timedSession();
    sync();
    client.emit({ type: 'stateSync', sessionId: 's', tableEpoch: 'epoch', participation: 'playing-hand', snapshot: snapshot({}) });
    expect(session.getTurnCountdown()).toBeNull();
    sync({ playerId: 'p2', deadlineAt: 40000, serverNow: 10000, durationMs: 30000 });
    expect(session.getTurnCountdown()).toBeNull();
    sync();
    sync(null);
    expect(session.getTurnCountdown()).toBeNull();
    sync(undefined, { actingPlayerId: null, legalActions: [] });
    expect(session.getTurnCountdown()).toBeNull();
    session.dispose();
  });

  it('clears on new hand, storage failure, runtime replacement, disconnect and dispose', () => {
    const { client, session, sync } = timedSession();
    sync();
    client.emit({ type: 'handStart', sessionId: 's', tableEpoch: 'epoch', handId: 2, dealerPlayerId: 'p1', participantIds: ['p1', 'p2', 'p3'] });
    expect(session.getTurnCountdown()).toBeNull();
    sync(undefined, { handId: 2 });
    client.emit({ type: 'error', code: 'storage-failed', message: '保存失败' });
    expect(session.getTurnCountdown()).toBeNull();
    sync(undefined, { handId: 2 });
    client.emit({ type: 'roomState', room: { ...ROOM, session: { ...ROOM.session, tableEpoch: 'new' } } });
    expect(session.getTurnCountdown()).toBeNull();
    client.emit({ type: 'stateSync', sessionId: 's', tableEpoch: 'new', participation: 'playing-hand', snapshot: snapshot({}), turnTimer: { playerId: 'p1', deadlineAt: 40000, serverNow: 35000, durationMs: 30000 } } as ServerMessage);
    expect(session.getTurnCountdown()?.seconds).toBe(5);
    client.onClose?.();
    expect(session.getTurnCountdown()).toBeNull();
    session.dispose();
    expect(session.getTurnCountdown()).toBeNull();
  });

  it('uses the remaining original deadline after recovery and ignores stale epochs', () => {
    const { client, session, sync } = timedSession();
    sync();
    client.emit({ type: 'recoveryNotice', notice: { sessionId: 's', tableEpoch: 'new', checkpointVersion: 0, rolledBackHandId: 1, reason: 'server-restart' } });
    expect(session.getTurnCountdown()).toBeNull();
    sync();
    expect(session.getTurnCountdown()).toBeNull();
    client.emit({ type: 'stateSync', sessionId: 's', tableEpoch: 'new', participation: 'playing-hand', snapshot: snapshot({}), turnTimer: { playerId: 'p2', deadlineAt: 40000, serverNow: 35000, durationMs: 30000 } } as ServerMessage);
    expect(session.getTurnCountdown()).toBeNull(); // Mismatched actor remains hidden.
    client.emit({ type: 'stateSync', sessionId: 's', tableEpoch: 'new', participation: 'playing-hand', snapshot: snapshot({}), turnTimer: { playerId: 'p1', deadlineAt: 40000, serverNow: 35000, durationMs: 30000 } } as ServerMessage);
    expect(session.getTurnCountdown()).toMatchObject({ handId: 1, seconds: 5, urgent: true });
    session.dispose();
  });
});

describe('OnlineSession fixed hand positions', () => {
  const begin = (client: FakeClient, handId = 1, ids = ['p1', 'p2', 'p3'], dealer = 'p1') =>
    client.emit({ type: 'handStart', sessionId: 's', tableEpoch: 'epoch', handId, dealerPlayerId: dealer, participantIds: ids });

  it('translates the exact dealt order and captures role metadata with its queued hand', async () => {
    const { client, session, updates } = createSession();
    client.emit({ type: 'roomState', room: ROOM });
    begin(client);
    client.emit({ type: 'stateSync', sessionId: 's', tableEpoch: 'epoch', participation: 'playing-hand', snapshot: snapshot({}) });
    await session.whenIdle();
    const expected = { handId: 1, dealerPlayerId: 'ai-2', smallBlindPlayerId: 'player', bigBlindPlayerId: 'ai-5' };
    expect(session.getHandPositions(1)).toEqual(expected);
    expect(updates.at(-1)?.handPositions).toEqual(expected);
    begin(client, 2, ['p1', 'p2', 'p3'], 'p2');
    expect(session.getHandPositions(1)).toBeNull();
    expect(updates.at(-1)?.handPositions).toEqual(expected);
    expect(session.getHandPositions(2)).toEqual({ handId: 2, dealerPlayerId: 'player', smallBlindPlayerId: 'ai-5', bigBlindPlayerId: 'ai-2' });
    session.dispose();
  });

  it('keeps blinds fixed when short all-in, folded, departed or settled', async () => {
    const { client, session } = createSession();
    client.emit({ type: 'roomState', room: ROOM });
    begin(client);
    const expected = session.getHandPositions(1);
    client.emit({ type: 'stateSync', sessionId: 's', tableEpoch: 'epoch', participation: 'playing-hand', snapshot: snapshot({
      street: 'settled', dealerPlayerId: null, actingPlayerId: null, legalActions: [],
      players: snapshot({}).players.map(player => ({ ...player, stack: 0, folded: true, allIn: true })),
    }) });
    client.emit({ type: 'roomState', room: { ...ROOM, seats: ROOM.seats.filter(seat => seat.playerId !== 'p2') } });
    await session.whenIdle();
    expect(expected).not.toBeNull();
    expect(session.getHandPositions(1)).toEqual(expected);
    session.dispose();
  });

  it('restores heads-up dealer and small blind even when the first snapshot is already settled', async () => {
    const { client, session, updates } = createSession();
    client.emit({ type: 'roomState', room: ROOM });
    begin(client, 4, ['p1', 'p2'], 'p2');
    client.emit({ type: 'stateSync', sessionId: 's', tableEpoch: 'epoch', participation: 'playing-hand', snapshot: snapshot({ handId: 4, street: 'settled', dealerPlayerId: null, actingPlayerId: null, legalActions: [] }) });
    await session.whenIdle();
    expect(session.getHandPositions(4)).toEqual({ handId: 4, dealerPlayerId: 'player', smallBlindPlayerId: 'player', bigBlindPlayerId: 'ai-5' });
    expect(updates.at(-1)?.handPositions).toEqual(session.getHandPositions(4));
    session.dispose();
  });

  it('uses participant order for a waiting spectator and does not include un-dealt seats', () => {
    const { client, session } = createSession();
    client.emit({ type: 'roomState', room: ROOM });
    begin(client, 3, ['p1', 'departed', 'p3'], 'p3');
    expect(session.getHandPositions(3)).toEqual({ handId: 3, dealerPlayerId: 'ai-2', smallBlindPlayerId: 'player', bigBlindPlayerId: 'ai-5' });
    session.dispose();
  });

  it('deduplicates replayed handStart, clears missed-hand data, then restores from authoritative handStart', async () => {
    const { client, session, updates } = createSession();
    client.emit({ type: 'roomState', room: ROOM });
    begin(client);
    const expected = session.getHandPositions(1);
    begin(client);
    expect(session.getHandPositions(1)).toEqual(expected);
    client.emit({ type: 'stateSync', sessionId: 's', tableEpoch: 'epoch', participation: 'playing-hand', snapshot: snapshot({ handId: 2 }) });
    await session.whenIdle();
    expect(session.getHandPositions(1)).toBeNull();
    expect(session.getHandPositions(2)).toBeNull();
    expect(updates.at(-1)?.handPositions).toBeNull();
    begin(client, 2, ['p1', 'p2', 'p3'], 'p2');
    expect(session.getHandPositions(2)?.dealerPlayerId).toBe('player');
    session.dispose();
  });

  it('clears role metadata on table replacement, lobby return and disposal', () => {
    const { client, session } = createSession();
    client.emit({ type: 'roomState', room: ROOM });
    begin(client);
    client.emit({ type: 'roomState', room: { ...ROOM, phase: 'lobby' } });
    expect(session.getHandPositions(1)).toBeNull();
    begin(client);
    client.emit({ type: 'roomState', room: { ...ROOM, session: { ...ROOM.session, tableEpoch: 'replacement' } } });
    expect(session.getHandPositions(1)).toBeNull();
    client.emit({ type: 'handStart', sessionId: 's', tableEpoch: 'replacement', handId: 1, dealerPlayerId: 'p1', participantIds: ['p1', 'p2', 'p3'] });
    expect(session.getHandPositions(1)).not.toBeNull();
    session.dispose();
    expect(session.getHandPositions(1)).toBeNull();
  });

  it('discards rolled-back hand positions and ignores the retired runtime replay', () => {
    const { client, session } = createSession();
    client.emit({ type: 'roomState', room: ROOM });
    begin(client);
    client.emit({ type: 'recoveryNotice', notice: { sessionId: 's', tableEpoch: 'new', checkpointVersion: 0, rolledBackHandId: 1, reason: 'server-restart' } });
    expect(session.getHandPositions(1)).toBeNull();
    begin(client);
    expect(session.getHandPositions(1)).toBeNull();
    client.emit({ type: 'handStart', sessionId: 's', tableEpoch: 'new', handId: 2, dealerPlayerId: 'p3', participantIds: ['p1', 'p2', 'p3'] });
    expect(session.getHandPositions(2)).toEqual({ handId: 2, dealerPlayerId: 'ai-5', smallBlindPlayerId: 'ai-2', bigBlindPlayerId: 'player' });
    session.dispose();
  });
});


describe('OnlineSession physical clockwise seating', () => {
  // Derive order from the actual rendered coordinates, independently of SeatOrder.
  const physicalSlots = getPokerSeatLayout().map(seat => ({
    id: seat.id, angle: (Math.atan2(seat.x, seat.y) - Math.PI + Math.PI * 2) % (Math.PI * 2),
  })).sort((a, b) => a.angle - b.angle).map(seat => seat.id);
  const cases = [2, 3, 6].flatMap(count => Array.from({ length: count }, (_, selfIndex) =>
    Array.from({ length: count }, (_, dealerIndex) => ({ count, selfIndex, dealerIndex }))).flat());

  it.each(cases)('preserves clockwise participants and roles for $count players, self $selfIndex, dealer $dealerIndex', async ({ count, selfIndex, dealerIndex }) => {
    const ids = Array.from({ length: count }, (_, i) => `p${i + 1}`);
    const self = ids[selfIndex];
    const room = { ...ROOM, seats: ids.map(id => ({ playerId: id, nickname: id, stack: 5000, connected: true })) };
    const { client, session, updates } = createSession(self);
    const visual = (id: string) => physicalSlots[(ids.indexOf(id) - selfIndex + count) % count];
    session.primeRoom(room);
    const start = { type: 'handStart' as const, sessionId: 's', tableEpoch: 'epoch', handId: 1, dealerPlayerId: ids[dealerIndex], participantIds: ids };
    client.emit(start);
    const actorIndex = count === 2 ? dealerIndex : (dealerIndex + 3) % count;
    const current = snapshot({ dealerPlayerId: ids[dealerIndex], actingPlayerId: ids[actorIndex], players: ids.map(id => ({ id, name: id, stack: 5000, folded: false, allIn: false, streetContribution: 0, totalContribution: 0 })) });
    client.emit({ type: 'stateSync', sessionId: 's', tableEpoch: 'epoch', participation: 'playing-hand', snapshot: current,
      turnTimer: { playerId: ids[actorIndex], deadlineAt: 40000, serverNow: 10000, durationMs: 30000 } });
    await session.whenIdle();
    const translated = updates.at(-1)?.snapshot!;
    expect(translated.players.map(player => player.id)).toEqual(ids.map(visual));
    expect(translated.actingPlayerId).toBe(visual(ids[actorIndex]));
    expect(session.getTurnCountdown()?.playerId).toBe(visual(ids[actorIndex]));
    expect(session.getHandPositions(1)).toEqual({ handId: 1,
      dealerPlayerId: visual(ids[dealerIndex]),
      smallBlindPlayerId: visual(ids[(dealerIndex + (count === 2 ? 0 : 1)) % count]),
      bigBlindPlayerId: visual(ids[(dealerIndex + (count === 2 ? 1 : 2)) % count]),
    });
    for (const id of ids) client.emit({ type: 'actionTaken', sessionId: 's', tableEpoch: 'epoch', handId: 1, playerId: id, action: { type: 'fold' }, amount: 0 });
    await session.whenIdle();
    expect(updates.slice(-count).map(update => (update.events[0] as Extract<EngineEvent, { type: 'action-taken' }>).playerId)).toEqual(ids.map(visual));
    expect(session.canAct()).toBe(actorIndex === selfIndex);
    session.sendAction({ type: 'call', amount: 40 });
    expect(client.sent.filter(message => message.type === 'action')).toHaveLength(actorIndex === selfIndex ? 1 : 0);

    // A reload replays the same dealt order; a departure and a waiting newcomer cannot move it.
    const restored = createSession(self);
    restored.session.primeRoom(room);
    restored.client.emit(start);
    restored.client.emit({ type: 'stateSync', sessionId: 's', tableEpoch: 'epoch', participation: 'playing-hand', snapshot: current });
    await restored.session.whenIdle();
    expect(restored.updates.at(-1)?.snapshot?.players).toEqual(translated.players);
    expect(restored.session.getHandPositions(1)).toEqual(session.getHandPositions(1));
    const departed = ids[(selfIndex + 1) % count];
    client.emit({ type: 'roomState', room: { ...room, seats: [...room.seats.filter(seat => seat.playerId !== departed), { playerId: 'waiting', nickname: 'Waiting', stack: 5000, connected: true }] } });
    client.emit({ type: 'stateSync', sessionId: 's', tableEpoch: 'epoch', participation: 'playing-hand', snapshot: current });
    await session.whenIdle();
    expect(updates.at(-1)?.snapshot?.players.map(player => player.id)).toEqual(ids.map(visual));
    expect(Array.from(session.seatNames().values())).not.toContain('Waiting');
    expect(session.seatNames().get(visual(departed))).toBe(departed);
    session.dispose(); restored.session.dispose();
  });
});
