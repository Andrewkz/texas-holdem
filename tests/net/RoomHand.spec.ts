import { sendCommand, setBoundaryStacks } from './v3Commands';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PokerEngine } from '../../assets/scripts/core/PokerEngine';
import { PlayerAction } from '../../assets/scripts/core/types';
import { RoomManager } from '../../server/src/RoomManager';
import { connect, createRoom, joinRoom } from './fakes';

function createManager(): RoomManager {
  return new RoomManager({ betweenHandsMs: 100, actionTimeoutMs: 10_000, reconnectWindowMs: 10_000 });
}

function startTwoPlayerGame(manager: RoomManager) {
  const alice = createRoom(manager);
  const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
  sendCommand(manager, alice.connection, { type: 'startGame' });
  return { alice, bob };
}

function passiveAction(manager: RoomManager, connection: Parameters<RoomManager['handleMessage']>[0], legalActions: PlayerAction[]): void {
  const action = legalActions.find((candidate) => candidate.type === 'check')
    ?? legalActions.find((candidate) => candidate.type === 'call');

  if (!action) {
    throw new Error('expected a passive legal action');
  }

  sendCommand(manager, connection, { type: 'action', action });
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

    sendCommand(manager, waiting.connection, { type: 'action', action: { type: 'fold' } });
    expect(waiting.connection.last('error')?.code).toBe('not-your-turn');

    sendCommand(manager, acting.connection, { type: 'action', action: { type: 'raise', to: 10 } });
    expect(acting.connection.last('error')?.code).toBe('illegal-action');
  });

  it('broadcasts actionTaken and moves the turn', () => {
    const manager = createManager();
    const { alice, bob } = startTwoPlayerGame(manager);

    const sync = alice.connection.last('stateSync')!;
    const acting = sync.snapshot.actingPlayerId === alice.joined.playerId ? alice : bob;
    const call = sync.snapshot.legalActions.find((action) => action.type === 'call');

    sendCommand(manager, acting.connection, { type: 'action', action: call ?? { type: 'check' } });

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
      passiveAction(manager, acting.connection, acting.connection.last('stateSync')!.snapshot.legalActions);
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
    sendCommand(manager, acting.connection, { type: 'action', action: { type: 'fold' } });

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

    sendCommand(manager, acting.connection, { type: 'action', action: { type: 'all-in' } });

    const call = waiting.connection.last('stateSync')!.snapshot.legalActions
      .find((action) => action.type === 'call')!;
    sendCommand(manager, waiting.connection, { type: 'action', action: call });

    const result = alice.connection.last('handResult')!;
    expect(bob.connection.last('handResult')).toEqual(result);
    const total = result.payouts.reduce((sum, payout) => sum + payout.amount, 0);
    expect(total).toBe(10000);
    expect(alice.connection.last('error')).toBeUndefined();
    expect(bob.connection.last('error')).toBeUndefined();

    // 跑码结算顺序：带 5 张公共牌的 stateSync 必须先于 showdown，showdown 先于 handResult
    const types = alice.connection.sent.map((message) => message.type);
    const runoutSyncIndex = alice.connection.sent.findIndex(
      (message) => message.type === 'stateSync' && message.snapshot.communityCards.length === 5,
    );
    const showdownIndex = types.indexOf('showdown');
    const resultIndex = types.indexOf('handResult');
    expect(runoutSyncIndex).toBeGreaterThan(-1);
    expect(showdownIndex).toBeGreaterThan(runoutSyncIndex);
    expect(resultIndex).toBeGreaterThan(showdownIndex);
  });

  it('keeps the dealer rotation on the remaining players when someone leaves between hands', () => {
    const manager = new RoomManager({ betweenHandsMs: 60_000, actionTimeoutMs: 10_000, reconnectWindowMs: 10_000 });
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
    const carol = joinRoom(manager, alice.joined.roomCode, 'Carol');
    sendCommand(manager, alice.connection, { type: 'startGame' });

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
      sendCommand(manager, acting.connection, { type: 'action', action: { type: 'fold' } });
    }
    expect(alice.connection.last('handResult')).toBeDefined();

    sendCommand(manager, alice.connection, { type: 'leaveRoom' });
    vi.advanceTimersByTime(60_000);

    // Alice 离开后庄家应从 Alice(p1) 轮转给 Bob(p2)，而不是因为数组下标漂移错给 Carol
    expect(bob.connection.last('handStart')!.dealerPlayerId).toBe(bob.joined.playerId);
  });

  it('clears pending timers when the room is emptied', () => {
    const manager = createManager();
    const { alice, bob } = startTwoPlayerGame(manager);

    const sync = alice.connection.last('stateSync')!;
    const acting = sync.snapshot.actingPlayerId === alice.joined.playerId ? alice : bob;
    sendCommand(manager, acting.connection, { type: 'action', action: { type: 'fold' } });
    expect(alice.connection.last('handResult')).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);

    sendCommand(manager, alice.connection, { type: 'leaveRoom' });
    sendCommand(manager, bob.connection, { type: 'leaveRoom' });

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
    sendCommand(manager, acting.connection, { type: 'action', action: { type: 'all-in' } });
    const call = waiting.connection.last('stateSync')!.snapshot.legalActions
      .find((action) => action.type === 'call')!;
    sendCommand(manager, waiting.connection, { type: 'action', action: call });
    rng.mockRestore();
    expect(alice.connection.last('handResult')).toBeDefined();

    // 下一手自动开始时只剩 1 人有筹码，房间回到大厅
    vi.advanceTimersByTime(150);
    expect(alice.connection.last('roomState')!.room.phase).toBe('lobby');

    sendCommand(manager, alice.connection, { type: 'startGame' });
    expect(alice.connection.last('error')?.code).toBe('bad-message');
    expect(alice.connection.last('roomState')!.room.phase).toBe('lobby');
  });

  it('runs out and settles a hand where both blinds are all-in', () => {
    const manager = createManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');

    const room = manager.getRoom(alice.joined.sessionId)!;
    setBoundaryStacks(room,{[alice.joined.playerId]:20,[bob.joined.playerId]:40});

    // 固定洗牌结果，保证这手牌分出胜负（输家清零）
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    sendCommand(manager, alice.connection, { type: 'startGame' });
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

    sendCommand(manager, alice.connection, { type: 'startGame' });

    expect(errorLog).toHaveBeenCalled();
    expect(alice.connection.last('roomState')!.room.phase).toBe('lobby');
    expect(alice.connection.last('handStart')).toBeUndefined();

    spy.mockRestore();
    errorLog.mockRestore();
  });
});


describe('recipient hand participation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives a late joiner public state immediately and no cards or actions on every push', () => {
    const manager = createManager();
    const { alice, bob } = startTwoPlayerGame(manager);
    const byId = { [alice.joined.playerId]: alice, [bob.joined.playerId]: bob };
    for (let i = 0; i < 2; i++) {
      const id = alice.connection.last('stateSync')!.snapshot.actingPlayerId!;
      const actor = byId[id];
      passiveAction(manager, actor.connection, actor.connection.last('stateSync')!.snapshot.legalActions);
    }
    const carol = joinRoom(manager, alice.joined.roomCode, 'Carol');
    expect(carol.connection.last('stateSync')?.snapshot.street).toBe('flop');
    expect(carol.connection.last('handStart')?.participantIds).toEqual([alice.joined.playerId, bob.joined.playerId]);
    expect(carol.connection.sent.filter(m => m.type !== 'hello' && m.type !== 'roomLookup')[0].type).toBe('joined');
    const before = carol.connection.last('stateSync')!.snapshot;
    sendCommand(manager, carol.connection, { type: 'action', action: { type: 'all-in' } });
    expect(carol.connection.last('error')?.code).toBe('not-your-turn');
    expect(carol.connection.last('stateSync')!.snapshot).toEqual(before);
    for (let i = 0; i < 3; i++) {
      const actor = byId[alice.connection.last('stateSync')!.snapshot.actingPlayerId!];
      passiveAction(manager, actor.connection, actor.connection.last('stateSync')!.snapshot.legalActions);
    }
    expect(carol.connection.sent.filter(m => m.type === 'stateSync').length).toBeGreaterThan(1);
    for (const m of carol.connection.sent) if (m.type === 'stateSync') {
      expect(m.participation).toBe('waiting-next-hand');
      expect(m.snapshot.legalActions).toEqual([]);
    }
    expect(carol.connection.last('yourHand')).toBeUndefined();
    for (const peer of [alice, bob]) {
      const sync = peer.connection.last('stateSync')!;
      expect(sync.participation).toBe('playing-hand');
      expect(sync.snapshot.legalActions.length > 0).toBe(sync.snapshot.actingPlayerId === peer.joined.playerId);
    }
  });

  it('replays the frozen participant list and recipient permissions after another participant folds', () => {
    const manager = createManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
    const carol = joinRoom(manager, alice.joined.roomCode, 'Carol');
    sendCommand(manager, alice.connection, { type: 'startGame' });
    expect(alice.connection.last('stateSync')!.snapshot.actingPlayerId).toBe(alice.joined.playerId);
    sendCommand(manager, alice.connection, { type: 'action', action: { type: 'fold' } });
    expect(bob.connection.last('stateSync')!.snapshot.actingPlayerId).toBe(bob.joined.playerId);
    manager.handleClose(carol.connection);

    const back = connect(manager);
    sendCommand(manager, back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: carol.joined.token });
    expect(back.last('handStart')!.participantIds).toEqual([alice.joined.playerId, bob.joined.playerId, carol.joined.playerId]);
    expect(back.last('yourHand')!.cards).toHaveLength(2);
    const restored = back.last('stateSync')!;
    expect(restored.snapshot.players.find(player => player.id === alice.joined.playerId)?.folded).toBe(true);
    expect(restored.participation).toBe('playing-hand');
    expect(restored.snapshot.actingPlayerId).toBe(bob.joined.playerId);
    expect(restored.snapshot.legalActions).toEqual([]);
    expect(alice.connection.last('stateSync')!.participation).toBe('playing-hand');
    expect(alice.connection.last('stateSync')!.snapshot.legalActions).toEqual([]);
    expect(bob.connection.last('stateSync')!.snapshot.legalActions.length).toBeGreaterThan(0);
  });

  it('does not reset an existing action deadline on recovery at 29 seconds', () => {
    const manager = new RoomManager({ betweenHandsMs: 60_000 });
    const { alice, bob } = startTwoPlayerGame(manager);
    const actor = alice.connection.last('stateSync')!.snapshot.actingPlayerId === alice.joined.playerId ? alice : bob;
    vi.advanceTimersByTime(29_000);
    manager.handleClose(actor.connection);
    const back = connect(manager);
    sendCommand(manager, back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: actor.joined.token });
    vi.advanceTimersByTime(1000);
    expect(back.last('actionTaken')?.playerId).toBe(actor.joined.playerId);
    expect(back.last('actionTaken')?.action.type).toBe('fold');
  });
});


describe('frozen hand identities', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps a three-player departed identity separate from its waiting replacement until the next hand', () => {
    const manager = new RoomManager({ actionTimeoutMs: 60_000, betweenHandsMs: 100 });
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
    const carol = joinRoom(manager, alice.joined.roomCode, 'Carol');
    sendCommand(manager, alice.connection, { type: 'startGame' });
    const originalIds = [alice.joined.playerId, bob.joined.playerId, carol.joined.playerId];
    expect(alice.connection.last('stateSync')!.snapshot.actingPlayerId).toBe(alice.joined.playerId);
    sendCommand(manager, bob.connection, { type: 'leaveRoom' });
    const dave = joinRoom(manager, alice.joined.roomCode, 'Dave');
    const initial = dave.connection.last('stateSync')!;
    expect(dave.joined.room.seats.map(seat => seat.nickname)).toEqual(['Alice', 'Carol', 'Dave']);
    expect(dave.connection.last('handStart')!.participantIds).toEqual(originalIds);
    expect(initial.snapshot.players.find(player => player.id === bob.joined.playerId)?.name).toBe('Bob');
    expect(initial.snapshot.players.some(player => player.id === dave.joined.playerId)).toBe(false);
    expect(initial.participation).toBe('waiting-next-hand');
    expect(initial.snapshot.legalActions).toEqual([]);
    expect(dave.connection.last('yourHand')).toBeUndefined();

    sendCommand(manager, dave.connection, { type: 'action', action: { type: 'all-in' } });
    expect(dave.connection.last('error')?.code).toBe('not-your-turn');
    expect(dave.connection.last('stateSync')).toEqual(initial);
    const call = alice.connection.last('stateSync')!.snapshot.legalActions.find(action => action.type === 'call');
    expect(call).toBeDefined();
    sendCommand(manager, alice.connection, { type: 'action', action: call! });
    expect(dave.connection.last('stateSync')!.snapshot.players.find(player => player.id === bob.joined.playerId))
      .toMatchObject({ name: 'Bob', folded: true });
    expect(dave.connection.last('stateSync')!.snapshot.actingPlayerId).toBe(carol.joined.playerId);
    sendCommand(manager, carol.connection, { type: 'action', action: { type: 'fold' } });
    expect(dave.connection.last('stateSync')!.snapshot.street).toBe('settled');
    for (const message of dave.connection.sent) if (message.type === 'stateSync') {
      expect(message.participation).toBe('waiting-next-hand');
      expect(message.snapshot.legalActions).toEqual([]);
    }
    expect(dave.connection.last('yourHand')).toBeUndefined();

    vi.advanceTimersByTime(100);
    expect(dave.connection.last('handStart')!.participantIds).toEqual([alice.joined.playerId, carol.joined.playerId, dave.joined.playerId]);
    expect(dave.connection.last('yourHand')!.handId).toBe(2);
    expect(dave.connection.last('yourHand')!.cards).toHaveLength(2);
    expect(dave.connection.last('stateSync')!.participation).toBe('playing-hand');
    expect(dave.connection.last('stateSync')!.snapshot.players.some(player => player.id === bob.joined.playerId)).toBe(false);
  });

  it('keeps departed players in the current public snapshot when a full table seat is reused', () => {
    const manager = new RoomManager({ actionTimeoutMs: 60_000, betweenHandsMs: 100 });
    const alice = createRoom(manager);
    const peers = [alice, ...['Bob', 'Carol', 'Dave', 'Eve', 'Frank'].map(name => joinRoom(manager, alice.joined.roomCode, name))];
    sendCommand(manager, alice.connection, { type: 'startGame' });
    const originalIds = peers.map(peer => peer.joined.playerId);
    sendCommand(manager, peers[1].connection, { type: 'leaveRoom' });
    const grace = joinRoom(manager, alice.joined.roomCode, 'Grace');
    expect(grace.connection.last('handStart')!.participantIds).toEqual(originalIds);
    expect(grace.connection.last('stateSync')!.snapshot.players.find(p => p.id === peers[1].joined.playerId)?.name).toBe('Bob');
    expect(grace.joined.room.seats.some(p => p.playerId === peers[1].joined.playerId)).toBe(false);
    expect(grace.connection.last('stateSync')!.participation).toBe('waiting-next-hand');
    expect(grace.connection.last('yourHand')).toBeUndefined();
    const byId = Object.fromEntries([...peers, grace].map(peer => [peer.joined.playerId, peer]));
    for (let guard = 0; guard < 6; guard++) {
      const sync = grace.connection.last('stateSync')!.snapshot;
      if (sync.street === 'settled') break;
      sendCommand(manager, byId[sync.actingPlayerId!].connection, { type: 'action', action: { type: 'fold' } });
    }
    expect(grace.connection.last('stateSync')!.snapshot.street).toBe('settled');
    vi.advanceTimersByTime(100);
    expect(grace.connection.last('handStart')!.participantIds).toContain(grace.joined.playerId);
    expect(grace.connection.last('handStart')!.participantIds).not.toContain(peers[1].joined.playerId);
    expect(grace.connection.last('yourHand')!.cards).toHaveLength(2);
    expect(grace.connection.last('stateSync')!.participation).toBe('playing-hand');
  });
});
