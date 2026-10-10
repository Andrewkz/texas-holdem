import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlayerAction } from '../../assets/scripts/core/types';
import { RoomManager } from '../../server/src/RoomManager';
import { connect, createRoom, joinRoom } from './fakes';

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
});
