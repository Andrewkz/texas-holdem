import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlayerAction } from '../../assets/scripts/core/types';
import { Room } from '../../server/src/Room';
import { RoomManager } from '../../server/src/RoomManager';
import { connect, createRoom, FakeConnection, joinRoom } from './fakes';

const OPTIONS = { actionTimeoutMs: 1_000, reconnectWindowMs: 2_000, betweenHandsMs: 10_000 };

function startTwoPlayerGame(options: Partial<typeof OPTIONS> = {}) {
  const manager = new RoomManager({ ...OPTIONS, ...options });
  const alice = createRoom(manager);
  const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
  manager.handleMessage(alice.connection, { type: 'startGame' });
  return { manager, alice, bob };
}

describe('room lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-folds the acting player after the action timeout when check is not free', () => {
    const { manager, alice } = startTwoPlayerGame();
    const actingId = alice.connection.last('stateSync')!.snapshot.actingPlayerId!;

    vi.advanceTimersByTime(OPTIONS.actionTimeoutMs + 50);

    const taken = alice.connection.last('actionTaken')!;
    expect(taken.playerId).toBe(actingId);
    expect(taken.action).toEqual({ type: 'fold' });
    expect(alice.connection.last('stateSync')!.snapshot.street).toBe('settled');
  });

  it('auto-checks instead of folding when checking is free', () => {
    const { manager, alice, bob } = startTwoPlayerGame();
    const byId = { [alice.joined.playerId]: alice, [bob.joined.playerId]: bob };

    // 第一位玩家主动行动（call 或 check），之后轮到第二位，大盲位可以免费过牌
    const first = alice.connection.last('stateSync')!.snapshot;
    const firstActor = byId[first.actingPlayerId!];
    const call = first.legalActions.find((action: PlayerAction) => action.type === 'call');
    manager.handleMessage(firstActor.connection, { type: 'action', action: call ?? { type: 'check' } });

    const second = alice.connection.last('stateSync')!.snapshot;
    expect(second.legalActions.some((action: PlayerAction) => action.type === 'check')).toBe(true);

    vi.advanceTimersByTime(OPTIONS.actionTimeoutMs + 50);

    const taken = alice.connection.last('actionTaken')!;
    expect(taken.playerId).toBe(second.actingPlayerId);
    expect(taken.action).toEqual({ type: 'check' });
    expect(alice.connection.last('stateSync')!.snapshot.street).toBe('flop');
  });

  it('resends hand state when a player reconnects mid-hand', () => {
    const { manager, alice, bob } = startTwoPlayerGame();
    manager.handleClose(bob.connection);

    const back = connect(manager);
    manager.handleMessage(back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: bob.joined.token });

    expect(back.last('joined')?.playerId).toBe(bob.joined.playerId);
    expect(back.last('handStart')?.handId).toBe(1);
    expect(back.last('yourHand')?.cards).toHaveLength(2);
    expect(back.last('stateSync')?.snapshot.street).toBe('preflop');
  });

  it('removes the seat after the reconnect window and auto-folds them out of the hand', () => {
    // 行动超时必须长于重连窗口：Alice 是首手庄家（heads-up 小盲先行动），
    // 否则推进重连窗口时会先触发她的超时弃牌，Bob 直接收池而轮不到自动弃牌
    const { manager, alice, bob } = startTwoPlayerGame({ actionTimeoutMs: 60_000 });
    manager.handleClose(bob.connection);
    vi.advanceTimersByTime(OPTIONS.reconnectWindowMs + 50);

    expect(alice.connection.last('roomState')!.room.seats).toHaveLength(1);

    // Alice（剩余玩家）做一个被动动作后，轮到 Bob 的引擎座位时被自动弃牌
    const sync = alice.connection.last('stateSync')!.snapshot;
    const call = sync.legalActions.find((action: PlayerAction) => action.type === 'call');
    manager.handleMessage(alice.connection, { type: 'action', action: call ?? { type: 'check' } });

    const folds = alice.connection.sent.filter(
      (message) => message.type === 'actionTaken' && message.action.type === 'fold' && message.playerId === bob.joined.playerId,
    );
    expect(folds.length).toBeGreaterThan(0);
    expect(alice.connection.last('handResult')?.payouts[0].playerId).toBe(alice.joined.playerId);
  });

  it('migrates the host when the host leaves mid-hand', () => {
    const { manager, alice, bob } = startTwoPlayerGame();
    manager.handleMessage(alice.connection, { type: 'leaveRoom' });

    const state = bob.connection.last('roomState')!.room;
    expect(state.hostId).toBe(bob.joined.playerId);
    expect(state.seats.map((seat) => seat.playerId)).toEqual([bob.joined.playerId]);
  });

  it('starts only one next hand when nested auto-fold settles the hand', () => {
    const manager = new RoomManager({ ...OPTIONS, actionTimeoutMs: 60_000, reconnectWindowMs: 2_000 });
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
    const carol = joinRoom(manager, alice.joined.roomCode, 'Carol');
    const dave = joinRoom(manager, alice.joined.roomCode, 'Dave');
    manager.handleMessage(alice.connection, { type: 'startGame' });

    // 4 人局：庄家 Alice，小盲 Bob，大盲 Carol，Dave 翻前第一个行动
    const first = alice.connection.last('stateSync')!.snapshot;
    expect(first.actingPlayerId).toBe(dave.joined.playerId);

    // Bob 和 Carol 断线超窗被移除（autoFold），Dave 主动弃牌但保留座位
    manager.handleClose(bob.connection);
    manager.handleClose(carol.connection);
    vi.advanceTimersByTime(2_050);
    expect(alice.connection.last('roomState')!.room.seats).toHaveLength(2);

    manager.handleMessage(dave.connection, { type: 'action', action: { type: 'fold' } });

    // Alice 跟注后依次轮到 Bob、Carol 的 autoFold 座位，嵌套弃牌并结算；
    // 嵌套的 applyAction 不能重复挂两手之间计时器，否则下一手会被开多次
    const sync = alice.connection.last('stateSync')!.snapshot;
    const call = sync.legalActions.find((action: PlayerAction) => action.type === 'call')!;
    manager.handleMessage(alice.connection, { type: 'action', action: call });
    expect(alice.connection.last('stateSync')!.snapshot.street).toBe('settled');
    expect(alice.connection.last('handResult')!.payouts[0].playerId).toBe(alice.joined.playerId);

    vi.advanceTimersByTime(OPTIONS.betweenHandsMs + 100);

    const handStarts = alice.connection.sent.filter((message) => message.type === 'handStart');
    expect(handStarts.map((message) => message.handId)).toEqual([1, 2]);
    expect(alice.connection.last('roomState')!.room.seats.map((seat) => seat.playerId))
      .toEqual([alice.joined.playerId, dave.joined.playerId]);
  });

  it('rejects reconnect with a stale token after the seat is removed', () => {
    // 同楼上：行动超时必须长于重连窗口，避免 Alice 先被超时弃牌
    const { manager, alice, bob } = startTwoPlayerGame({ actionTimeoutMs: 60_000 });
    manager.handleClose(bob.connection);
    vi.advanceTimersByTime(OPTIONS.reconnectWindowMs + 50);

    expect(alice.connection.last('roomState')!.room.seats).toHaveLength(1);

    const back = connect(manager);
    manager.handleMessage(back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: bob.joined.token });

    expect(back.last('joined')).toBeUndefined();
    expect(back.last('error')?.code).toBe('room-not-found');
  });

  it('skips a departed non-dealer when rotating the dealer', () => {
    const manager = new RoomManager({ actionTimeoutMs: 10_000, reconnectWindowMs: 10_000, betweenHandsMs: 100 });
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
    const carol = joinRoom(manager, alice.joined.roomCode, 'Carol');
    manager.handleMessage(alice.connection, { type: 'startGame' });
    const byId = { [alice.joined.playerId]: alice, [bob.joined.playerId]: bob, [carol.joined.playerId]: carol };

    expect(alice.connection.last('handStart')!.dealerPlayerId).toBe(alice.joined.playerId);

    // 3 人局翻牌前庄家先行动：前两家弃牌，第三家收池，快速结束手牌
    for (let folds = 0; folds < 2; folds += 1) {
      const sync = alice.connection.last('stateSync')!;
      const acting = byId[sync.snapshot.actingPlayerId!];
      manager.handleMessage(acting.connection, { type: 'action', action: { type: 'fold' } });
    }
    expect(alice.connection.last('stateSync')!.snapshot.street).toBe('settled');

    // Bob（非庄家）在两手之间离开，庄家按钮从 Alice 顺延到 Carol
    manager.handleMessage(bob.connection, { type: 'leaveRoom' });
    vi.advanceTimersByTime(150);

    expect(alice.connection.last('handStart')!.dealerPlayerId).toBe(carol.joined.playerId);
  });

  it('rotates the dealer to the next seat when the dealer themselves depart', () => {
    const manager = new RoomManager({ actionTimeoutMs: 10_000, reconnectWindowMs: 10_000, betweenHandsMs: 100 });
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
    const carol = joinRoom(manager, alice.joined.roomCode, 'Carol');
    manager.handleMessage(alice.connection, { type: 'startGame' });
    const byId = { [alice.joined.playerId]: alice, [bob.joined.playerId]: bob, [carol.joined.playerId]: carol };

    expect(alice.connection.last('handStart')!.dealerPlayerId).toBe(alice.joined.playerId);

    // 第一手：前两家弃牌收池，开第二手（庄家轮到 Bob）
    for (let folds = 0; folds < 2; folds += 1) {
      const sync = alice.connection.last('stateSync')!;
      manager.handleMessage(byId[sync.snapshot.actingPlayerId!].connection, { type: 'action', action: { type: 'fold' } });
    }
    vi.advanceTimersByTime(150);
    expect(alice.connection.last('handStart')!.dealerPlayerId).toBe(bob.joined.playerId);

    // 第二手同样快速收池
    for (let folds = 0; folds < 2; folds += 1) {
      const sync = alice.connection.last('stateSync')!;
      manager.handleMessage(byId[sync.snapshot.actingPlayerId!].connection, { type: 'action', action: { type: 'fold' } });
    }
    expect(alice.connection.last('stateSync')!.snapshot.street).toBe('settled');

    // 庄家 Bob 本人在两手之间离开：第三手庄家应是 Bob 的下一位 Carol，而不是回退到座位 0 的 Alice
    manager.handleMessage(bob.connection, { type: 'leaveRoom' });
    expect(alice.connection.last('roomState')!.room.seats.map((seat) => seat.playerId))
      .toEqual([alice.joined.playerId, carol.joined.playerId]);

    vi.advanceTimersByTime(150);
    expect(alice.connection.last('handStart')!.dealerPlayerId).toBe(carol.joined.playerId);
  });

  it('recovers the dealer from blinds when a two-stack hand settles instantly with extra seated players', () => {
    // 三人入座但只有两人有筹码时走 heads-up 盲注结构（小盲即庄家）：
    // 盲注全押开局即结算，快照不含庄家，必须从 blind-posted 事件找回——
    // 即便座位数大于 2。否则庄家会被错记成 0 筹码的座位 0 玩家。
    const room = new Room('TEST', { actionTimeoutMs: 10_000, reconnectWindowMs: 10_000, betweenHandsMs: 60_000 }, () => {});
    const connection = new FakeConnection();
    const alice = room.addPlayer('Alice', connection);
    const bob = room.addPlayer('Bob', new FakeConnection());
    const carol = room.addPlayer('Carol', new FakeConnection());
    if (!alice.ok || !bob.ok || !carol.ok) {
      throw new Error('expected joins to succeed');
    }
    alice.player.stack = 0;
    bob.player.stack = 20;
    carol.player.stack = 40;

    room.startGame(alice.player.id);

    const handStart = connection.last('handStart')!;
    expect(handStart.dealerPlayerId).toBe(bob.player.id);
    expect(connection.last('stateSync')!.snapshot.street).toBe('settled');
  });
});
