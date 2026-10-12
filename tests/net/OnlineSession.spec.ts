import { describe, expect, it } from 'vitest';

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
  const session = new OnlineSession(client as never, {
    playerId: 'p2',
    credentials: { roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
    handlers: {
      onTableUpdate: (update) => {
        updates.push(update);
        return Promise.resolve();
      },
      onRoomState: (room) => rooms.push(room),
      onSessionLost: () => undefined,
    },
    reconnectDelayMs: 1,
    maxReconnectAttempts: 1,
  });
  return { client, session, updates, rooms };
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
});
