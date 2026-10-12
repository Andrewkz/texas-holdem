import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PokerEngine } from '../../assets/scripts/core/PokerEngine';
import { PlayerAction } from '../../assets/scripts/core/types';
import { RoomManager } from '../../server/src/RoomManager';
import { createRoom, joinRoom } from './fakes';

function createManager(): RoomManager {
  return new RoomManager({ betweenHandsMs: 100, actionTimeoutMs: 10_000, reconnectWindowMs: 10_000 });
}

function startTwoPlayerGame(manager: RoomManager) {
  const alice = createRoom(manager);
  const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
  manager.handleMessage(alice.connection, { type: 'startGame' });
  return { alice, bob };
}

function passiveAction(manager: RoomManager, connection: Parameters<RoomManager['handleMessage']>[0], legalActions: PlayerAction[]): void {
  const action = legalActions.find((candidate) => candidate.type === 'check')
    ?? legalActions.find((candidate) => candidate.type === 'call');

  if (!action) {
    throw new Error('expected a passive legal action');
  }

  manager.handleMessage(connection, { type: 'action', action });
}

describe('room hand flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a hand, deals private hands and broadcasts public state', () => {
    const manager = createManager();
    const { alice, bob } = startTwoPlayerGame(manager);

    const handStart = alice.connection.last('handStart')!;
    expect(handStart.handId).toBe(1);
    expect(bob.connection.last('handStart')).toEqual(handStart);

    const aliceHand = alice.connection.last('yourHand')!;
    const bobHand = bob.connection.last('yourHand')!;
    expect(aliceHand.cards).toHaveLength(2);
    expect(bobHand.cards).toHaveLength(2);

    // 私密性：Bob 收到的所有消息里绝不能出现 Alice 的牌
    const bobWire = JSON.stringify(bob.connection.sent);
    for (const card of aliceHand.cards) {
      expect(bobWire).not.toContain(JSON.stringify(card));
    }

    const sync = alice.connection.last('stateSync')!;
    expect(sync.snapshot.street).toBe('preflop');
    expect(sync.snapshot.pot).toBe(60);
    expect(sync.snapshot.actingPlayerId).not.toBeNull();
    expect(sync.snapshot.players).toHaveLength(2);
    expect(JSON.stringify(sync)).not.toContain('holeCards');
    expect(alice.connection.last('roomState')!.room.phase).toBe('playing');
  });

  it('rejects actions from the wrong player or with illegal amounts', () => {
    const manager = createManager();
    const { alice, bob } = startTwoPlayerGame(manager);

    const sync = alice.connection.last('stateSync')!;
    const acting = sync.snapshot.actingPlayerId === alice.joined.playerId ? alice : bob;
    const waiting = acting === alice ? bob : alice;

    manager.handleMessage(waiting.connection, { type: 'action', action: { type: 'fold' } });
    expect(waiting.connection.last('error')?.code).toBe('not-your-turn');

    manager.handleMessage(acting.connection, { type: 'action', action: { type: 'raise', to: 10 } });
    expect(acting.connection.last('error')?.code).toBe('illegal-action');
  });

  it('broadcasts actionTaken and moves the turn', () => {
    const manager = createManager();
    const { alice, bob } = startTwoPlayerGame(manager);

    const sync = alice.connection.last('stateSync')!;
    const acting = sync.snapshot.actingPlayerId === alice.joined.playerId ? alice : bob;
    const call = sync.snapshot.legalActions.find((action) => action.type === 'call');

    manager.handleMessage(acting.connection, { type: 'action', action: call ?? { type: 'check' } });

    const taken = bob.connection.last('actionTaken')!;
    expect(taken.playerId).toBe(acting.joined.playerId);
    expect(alice.connection.last('stateSync')!.snapshot.actingPlayerId).not.toBe(acting.joined.playerId);
  });

  it('plays a full checked-down hand to showdown and starts the next hand automatically', () => {
    const manager = createManager();
    const { alice, bob } = startTwoPlayerGame(manager);
    const byId = { [alice.joined.playerId]: alice, [bob.joined.playerId]: bob };

    for (let guard = 0; guard < 40; guard += 1) {
      const sync = alice.connection.last('stateSync')!;
      if (sync.snapshot.street === 'settled') {
        break;
      }

      const acting = byId[sync.snapshot.actingPlayerId!];
      passiveAction(manager, acting.connection, sync.snapshot.legalActions);
    }

    expect(alice.connection.last('stateSync')!.snapshot.street).toBe('settled');

    const showdown = alice.connection.last('showdown')!;
    expect(showdown.reveals).toHaveLength(2);
    for (const reveal of showdown.reveals) {
      expect(reveal.cards).toHaveLength(2);
      expect(reveal.handName.length).toBeGreaterThan(0);
    }

    const result = alice.connection.last('handResult')!;
    const totalPayout = result.payouts.reduce((sum, payout) => sum + payout.amount, 0);
    // 盲注 20/40 + 小盲补跟 20，全过牌到底后底池共 80
    expect(totalPayout).toBe(80);

    vi.advanceTimersByTime(150);
    expect(alice.connection.last('handStart')!.handId).toBe(2);
  });

  it('awards the pot immediately when a player folds preflop and reveals nothing', () => {
    const manager = createManager();
    const { alice, bob } = startTwoPlayerGame(manager);

    const sync = alice.connection.last('stateSync')!;
    const acting = sync.snapshot.actingPlayerId === alice.joined.playerId ? alice : bob;
    manager.handleMessage(acting.connection, { type: 'action', action: { type: 'fold' } });

    const result = bob.connection.last('handResult')!;
    expect(result.payouts).toHaveLength(1);
    expect(result.payouts[0].amount).toBe(60);
    expect(bob.connection.last('showdown')).toBeUndefined();

    // 弃牌收池后赢家筹码增加（5000 - 自己的盲注/投入 + 60）
    const winnerId = result.payouts[0].playerId;
    const roomState = alice.connection.last('roomState')!.room;
    const winnerSeat = roomState.seats.find((seat) => seat.playerId === winnerId)!;
    expect(winnerSeat.stack).toBeGreaterThan(5000 - 40);
  });

  it('settles a heads-up all-in runout without errors', () => {
    const manager = createManager();
    const { alice, bob } = startTwoPlayerGame(manager);

    const sync = alice.connection.last('stateSync')!;
    const acting = sync.snapshot.actingPlayerId === alice.joined.playerId ? alice : bob;
    const waiting = acting === alice ? bob : alice;

    manager.handleMessage(acting.connection, { type: 'action', action: { type: 'all-in' } });

    const call = alice.connection.last('stateSync')!.snapshot.legalActions
      .find((action) => action.type === 'call')!;
    manager.handleMessage(waiting.connection, { type: 'action', action: call });

    const result = alice.connection.last('handResult')!;
    expect(bob.connection.last('handResult')).toEqual(result);
    const total = result.payouts.reduce((sum, payout) => sum + payout.amount, 0);
    expect(total).toBe(10000);
    expect(alice.connection.last('error')).toBeUndefined();
    expect(bob.connection.last('error')).toBeUndefined();
  });

  it('keeps the dealer rotation on the remaining players when someone leaves between hands', () => {
    const manager = new RoomManager({ betweenHandsMs: 60_000, actionTimeoutMs: 10_000, reconnectWindowMs: 10_000 });
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
    const carol = joinRoom(manager, alice.joined.roomCode, 'Carol');
    manager.handleMessage(alice.connection, { type: 'startGame' });

    expect(alice.connection.last('handStart')!.dealerPlayerId).toBe(alice.joined.playerId);

    // 3 人局翻牌前庄家先行动：前两家弃牌，第三家收池，快速结束手牌
    const byId = {
      [alice.joined.playerId]: alice,
      [bob.joined.playerId]: bob,
      [carol.joined.playerId]: carol,
    };
    for (let folds = 0; folds < 2; folds += 1) {
      const sync = alice.connection.last('stateSync')!;
      const acting = byId[sync.snapshot.actingPlayerId!];
      manager.handleMessage(acting.connection, { type: 'action', action: { type: 'fold' } });
    }
    expect(alice.connection.last('handResult')).toBeDefined();

    manager.handleMessage(alice.connection, { type: 'leaveRoom' });
    vi.advanceTimersByTime(60_000);

    // Alice 离开后庄家应从 Alice(p1) 轮转给 Bob(p2)，而不是因为数组下标漂移错给 Carol
    expect(bob.connection.last('handStart')!.dealerPlayerId).toBe(bob.joined.playerId);
  });

  it('clears pending timers when the room is emptied', () => {
    const manager = createManager();
    const { alice, bob } = startTwoPlayerGame(manager);

    const sync = alice.connection.last('stateSync')!;
    const acting = sync.snapshot.actingPlayerId === alice.joined.playerId ? alice : bob;
    manager.handleMessage(acting.connection, { type: 'action', action: { type: 'fold' } });
    expect(alice.connection.last('handResult')).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);

    manager.handleMessage(alice.connection, { type: 'leaveRoom' });
    manager.handleMessage(bob.connection, { type: 'leaveRoom' });

    expect(manager.roomCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses to start when fewer than two seated players have chips', () => {
    const manager = createManager();
    // 洗牌发生在 startGame 里，必须在开牌前固定随机数，保证 all-in 对决分出胜负（不分池）
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { alice, bob } = startTwoPlayerGame(manager);

    // 全押对决，输家清零
    const sync = alice.connection.last('stateSync')!;
    const acting = sync.snapshot.actingPlayerId === alice.joined.playerId ? alice : bob;
    const waiting = acting === alice ? bob : alice;
    manager.handleMessage(acting.connection, { type: 'action', action: { type: 'all-in' } });
    const call = alice.connection.last('stateSync')!.snapshot.legalActions
      .find((action) => action.type === 'call')!;
    manager.handleMessage(waiting.connection, { type: 'action', action: call });
    rng.mockRestore();
    expect(alice.connection.last('handResult')).toBeDefined();

    // 下一手自动开始时只剩 1 人有筹码，房间回到大厅
    vi.advanceTimersByTime(150);
    expect(alice.connection.last('roomState')!.room.phase).toBe('lobby');

    manager.handleMessage(alice.connection, { type: 'startGame' });
    expect(alice.connection.last('error')?.code).toBe('bad-message');
    expect(alice.connection.last('roomState')!.room.phase).toBe('lobby');
  });

  it('runs out and settles a hand where both blinds are all-in', () => {
    const manager = createManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');

    // 篡改座位筹码，构造双盲即全押的极端局面
    const room = (manager as unknown as { rooms: Map<string, { players: { id: string; stack: number }[] }> })
      .rooms.get(alice.joined.roomCode)!;
    room.players.find((player) => player.id === alice.joined.playerId)!.stack = 20;
    room.players.find((player) => player.id === bob.joined.playerId)!.stack = 40;

    // 固定洗牌结果，保证这手牌分出胜负（输家清零）
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    manager.handleMessage(alice.connection, { type: 'startGame' });
    rng.mockRestore();

    // heads-up 小盲即庄家；引擎直接跑完结算时快照没有庄家，从盲注事件找回
    expect(alice.connection.last('handStart')!.dealerPlayerId).toBe(alice.joined.playerId);
    expect(alice.connection.last('yourHand')!.cards).toHaveLength(2);

    const sync = alice.connection.last('stateSync')!;
    expect(sync.snapshot.street).toBe('settled');
    expect(sync.snapshot.communityCards).toHaveLength(5);

    expect(alice.connection.last('showdown')!.reveals).toHaveLength(2);
    const result = alice.connection.last('handResult')!;
    expect(bob.connection.last('handResult')).toEqual(result);
    expect(result.payouts.reduce((sum, payout) => sum + payout.amount, 0)).toBe(60);
    expect(alice.connection.last('error')).toBeUndefined();
    expect(bob.connection.last('error')).toBeUndefined();

    // 输家清零，下一手自动开始时只剩 1 人有筹码，回到大厅
    vi.advanceTimersByTime(150);
    expect(alice.connection.last('roomState')!.room.phase).toBe('lobby');
  });

  it('falls back to the lobby instead of crashing when the engine fails to start a hand', () => {
    const manager = createManager();
    const alice = createRoom(manager);
    joinRoom(manager, alice.joined.roomCode, 'Bob');

    const spy = vi.spyOn(PokerEngine, 'createWithPlayers').mockImplementation(() => {
      throw new Error('boom');
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    manager.handleMessage(alice.connection, { type: 'startGame' });

    expect(errorLog).toHaveBeenCalled();
    expect(alice.connection.last('roomState')!.room.phase).toBe('lobby');
    expect(alice.connection.last('handStart')).toBeUndefined();

    spy.mockRestore();
    errorLog.mockRestore();
  });
});
