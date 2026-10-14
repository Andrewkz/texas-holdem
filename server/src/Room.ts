import { randomUUID } from 'node:crypto';

import { PokerEngine } from '../../assets/scripts/core/PokerEngine';
import { EngineEvent, EngineSnapshot, PlayerAction } from '../../assets/scripts/core/types';
import {
  ACTION_TIMEOUT_MS,
  BETWEEN_HANDS_MS,
  ErrorCode,
  MAX_SEATS,
  RECONNECT_WINDOW_MS,
  RoomStateMessage,
  ServerMessage,
  STARTING_STACK,
} from '../../assets/scripts/net/protocol';
import { ClientConnection } from './types';

export interface RoomPlayer {
  id: string;
  nickname: string;
  token: string;
  stack: number;
  connected: boolean;
  connection: ClientConnection | null;
  autoFold: boolean;
}

export interface RoomOptions {
  actionTimeoutMs?: number;
  reconnectWindowMs?: number;
  betweenHandsMs?: number;
}

export type JoinResult =
  | { ok: true; player: RoomPlayer }
  | { ok: false; code: ErrorCode; message: string };

export class Room {
  public phase: 'lobby' | 'playing' = 'lobby';
  public hostId = '';
  protected readonly players: RoomPlayer[] = [];
  protected readonly options: Required<RoomOptions>;
  private nextPlayerNumber = 1;
  private engine: PokerEngine | null = null;
  private lastDealerPlayerId: string | null = null;
  private lastDealerSeatIndex = -1;
  private handNumber = 0;
  private actionTimer: ReturnType<typeof setTimeout> | null = null;
  private betweenHandsTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  public constructor(
    public readonly code: string,
    options: RoomOptions,
    private readonly onEmpty: () => void,
  ) {
    this.options = {
      actionTimeoutMs: options.actionTimeoutMs ?? ACTION_TIMEOUT_MS,
      reconnectWindowMs: options.reconnectWindowMs ?? RECONNECT_WINDOW_MS,
      betweenHandsMs: options.betweenHandsMs ?? BETWEEN_HANDS_MS,
    };
  }

  public addPlayer(nickname: string, connection: ClientConnection): JoinResult {
    if (this.seatedPlayers().length >= MAX_SEATS) {
      return { ok: false, code: 'room-full', message: '房间已满' };
    }

    if (this.players.some((player) => player.nickname === nickname && !player.autoFold)) {
      return { ok: false, code: 'nickname-taken', message: '昵称已被占用' };
    }

    const player: RoomPlayer = {
      id: `p${this.nextPlayerNumber}`,
      nickname,
      token: randomUUID(),
      stack: STARTING_STACK,
      connected: true,
      connection,
      autoFold: false,
    };
    this.nextPlayerNumber += 1;
    this.players.push(player);

    if (!this.hostId) {
      this.hostId = player.id;
    }

    this.broadcastRoomState();
    return { ok: true, player };
  }

  public reconnectPlayer(token: string, connection: ClientConnection): RoomPlayer | null {
    const player = this.players.find((candidate) => candidate.token === token) ?? null;

    // autoFold 幽灵的座位已移除（等手牌结束清出名单），token 不再可用，客户端应重新 joinRoom
    if (!player || player.autoFold) {
      return null;
    }

    const timer = this.reconnectTimers.get(player.id);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(player.id);
    }

    // 顶号：旧连接（如另一个标签页）明确告知后关闭，避免两侧互相顶号死循环
    const previous = player.connection;
    if (previous && previous !== connection) {
      previous.send({ type: 'error', code: 'session-taken-over', message: '该座位已在别处登录' });
      previous.close?.();
    }

    player.connected = true;
    player.connection = connection;
    this.broadcastRoomState();
    return player;
  }

  public markDisconnected(playerId: string): void {
    const player = this.players.find((candidate) => candidate.id === playerId);

    if (!player || player.autoFold) {
      return;
    }

    player.connected = false;
    player.connection = null;
    this.broadcastRoomState();

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(playerId);
      if (!player.connected) {
        this.removePlayer(playerId);
      }
    }, this.options.reconnectWindowMs);
    this.reconnectTimers.set(playerId, timer);
  }

  public removePlayer(playerId: string): void {
    const player = this.players.find((candidate) => candidate.id === playerId);

    if (!player) {
      return;
    }

    const timer = this.reconnectTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(playerId);
    }

    const inHand = this.phase === 'playing'
      && this.engine !== null
      && this.engine.snapshot().players.some((candidate) => candidate.id === playerId)
      && this.engine.snapshot().street !== 'settled';

    if (inHand) {
      player.autoFold = true;
      player.connected = false;
      player.connection = null;

      const snapshot = this.engine!.snapshot();
      if (snapshot.actingPlayerId === playerId && snapshot.legalActions.length > 0) {
        this.applyAction(playerId, { type: 'fold' });
      }
    } else {
      this.players.splice(this.players.indexOf(player), 1);
    }

    if (this.hostId === playerId) {
      this.hostId = this.seatedPlayers()[0]?.id ?? '';
    }

    if (this.seatedPlayers().length === 0) {
      this.clearActionTimer();
      if (this.betweenHandsTimer) {
        clearTimeout(this.betweenHandsTimer);
        this.betweenHandsTimer = null;
      }
      this.onEmpty();
      return;
    }

    this.broadcastRoomState();
  }

  public roomState(): RoomStateMessage {
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      seats: this.seatedPlayers().map((player) => ({
        playerId: player.id,
        nickname: player.nickname,
        stack: player.stack,
        connected: player.connected,
      })),
    };
  }

  public broadcastRoomState(): void {
    this.broadcast({ type: 'roomState', room: this.roomState() });
  }

  protected seatedPlayers(): RoomPlayer[] {
    return this.players.filter((player) => !player.autoFold);
  }

  protected broadcast(message: ServerMessage): void {
    for (const player of this.players) {
      player.connection?.send(message);
    }
  }

  protected sendTo(player: RoomPlayer, message: ServerMessage): void {
    player.connection?.send(message);
  }

  public startGame(playerId: string): { ok: true } | { ok: false; code: ErrorCode; message: string } {
    if (playerId !== this.hostId) {
      return { ok: false, code: 'not-host', message: '只有房主可以开始游戏' };
    }

    if (this.phase !== 'lobby') {
      return { ok: false, code: 'bad-message', message: '牌局已开始' };
    }

    if (this.seatedPlayers().filter((player) => player.stack > 0).length < 2) {
      return { ok: false, code: 'bad-message', message: '至少需要 2 名有筹码的玩家' };
    }

    this.startHand();
    return { ok: true };
  }

  public handleAction(playerId: string, action: PlayerAction): void {
    const player = this.players.find((candidate) => candidate.id === playerId);

    if (!player || !this.engine || this.phase !== 'playing') {
      if (player) {
        this.sendTo(player, { type: 'error', code: 'game-not-started', message: '牌局尚未开始' });
      }
      return;
    }

    if (this.engine.snapshot().actingPlayerId !== playerId) {
      this.sendTo(player, { type: 'error', code: 'not-your-turn', message: '还没轮到你行动' });
      return;
    }

    this.applyAction(playerId, action);
  }

  protected startHand(): void {
    const seated = this.seatedPlayers();

    if (seated.filter((player) => player.stack > 0).length < 2) {
      this.phase = 'lobby';
      this.engine = null;
      this.broadcastRoomState();
      return;
    }

    this.phase = 'playing';
    // 按玩家 id 追踪庄家，避免有人离座后数组下标漂移导致轮转错位；
    // 庄家本人离席（id 找不到）时，其继任者在 splice 后的新数组中下标恰好前移一位，
    // 传"原座位号 - 1"让引擎的 nextPlayingIndex 落到正确的下一位
    let initialDealerIndex = -1;
    if (this.lastDealerPlayerId) {
      const byId = seated.findIndex((player) => player.id === this.lastDealerPlayerId);
      initialDealerIndex = byId !== -1
        ? byId
        : (this.lastDealerSeatIndex > 0 ? this.lastDealerSeatIndex - 1 : -1);
    }

    let snapshot: EngineSnapshot;
    try {
      this.engine = PokerEngine.createWithPlayers(
        seated.map((player) => ({ id: player.id, name: player.nickname })),
        {
          stacks: Object.fromEntries(seated.map((player) => [player.id, player.stack])),
          initialDealerIndex,
        },
      );
      snapshot = this.engine.startHand();
    } catch (error) {
      // 兜底：引擎开局失败不能让定时器回调里的异常击垮进程，回退大厅
      console.error(error);
      this.phase = 'lobby';
      this.engine = null;
      this.broadcastRoomState();
      return;
    }

    // 双盲全押等情形下引擎在开局内直接结算，此时快照不含庄家。
    // 开局即结算只可能在仅剩两名有筹码玩家时发生（但凡还有第三家持有筹码，
    // 他未下盲注便必然有待行动），此时走 heads-up 盲注结构、小盲即庄家，
    // 从盲注事件找回庄家 id；其余（不可达的）多人直结保持上次庄家不变
    const settledEvents = snapshot.street === 'settled' ? this.engine.takeEvents() : [];
    const playingCount = seated.filter((player) => player.stack > 0).length;
    const recoveredDealerId = playingCount === 2
      ? settledEvents.find((event) => event.type === 'blind-posted')?.playerId
      : undefined;
    const dealerPlayerId = snapshot.dealerPlayerId
      ?? recoveredDealerId
      ?? this.lastDealerPlayerId
      ?? seated[0].id;
    // 引擎每手重建、handId 归零，房间里自行累计手牌序号
    this.handNumber += 1;
    this.broadcast({ type: 'handStart', handId: this.handNumber, dealerPlayerId });

    const dealerSeatIndex = seated.findIndex((player) => player.id === dealerPlayerId);
    if (dealerSeatIndex !== -1) {
      this.lastDealerPlayerId = dealerPlayerId;
      this.lastDealerSeatIndex = dealerSeatIndex;
    }

    for (const player of seated) {
      this.sendTo(player, { type: 'yourHand', handId: this.handNumber, cards: this.engine.getHoleCards(player.id) });
    }

    this.broadcastRoomState();
    this.broadcastStateSync();

    if (snapshot.street === 'settled') {
      this.broadcastSettlementEvents(settledEvents);
      this.finishHand();
      return;
    }

    this.scheduleActionTimeout();
  }

  private broadcastSettlementEvents(events: EngineEvent[]): void {
    const reveals = events.filter((event): event is Extract<EngineEvent, { type: 'showdown' }> => event.type === 'showdown');
    if (reveals.length > 0) {
      this.broadcast({
        type: 'showdown',
        handId: this.handNumber,
        reveals: reveals.map((event) => ({ playerId: event.playerId, cards: event.cards, handName: event.handName })),
      });
    }

    const payouts = events.filter((event): event is Extract<EngineEvent, { type: 'pot-awarded' }> => event.type === 'pot-awarded');
    if (payouts.length > 0) {
      this.broadcast({
        type: 'handResult',
        handId: this.handNumber,
        payouts: payouts.map((event) => ({ playerId: event.playerId, amount: event.amount, handName: event.handName })),
      });
    }
  }

  protected applyAction(playerId: string, action: PlayerAction): void {
    let events: EngineEvent[];

    try {
      events = this.engine!.act(action);
    } catch (error) {
      const player = this.players.find((candidate) => candidate.id === playerId);
      if (player) {
        if (error instanceof Error && error.message === 'Illegal action') {
          this.sendTo(player, { type: 'error', code: 'illegal-action', message: '行动不合法' });
        } else {
          console.error(error);
          this.sendTo(player, { type: 'error', code: 'bad-message', message: '服务器内部错误' });
        }
      }
      return;
    }

    for (const event of events) {
      if (event.type === 'action-taken') {
        this.broadcast({ type: 'actionTaken', playerId: event.playerId, action: event.action, amount: event.amount });
      }
    }

    // stateSync 先于结算广播：客户端靠它 diff 出公共牌翻开事件，
    // all-in 跑码（单次 act 内结算）时牌面必须先于摊牌/派彩出现
    this.broadcastStateSync();

    this.broadcastSettlementEvents(events);

    if (this.engine!.snapshot().street === 'settled') {
      this.finishHand();
    } else {
      this.scheduleActionTimeout();
    }
  }

  protected broadcastStateSync(): void {
    if (!this.engine) {
      return;
    }

    const snapshot = { ...this.engine.snapshot(), handId: this.handNumber };
    this.broadcast({ type: 'stateSync', snapshot });

    const acting = snapshot.actingPlayerId
      ? this.players.find((candidate) => candidate.id === snapshot.actingPlayerId)
      : null;

    if (acting?.autoFold === true && snapshot.legalActions.length > 0) {
      this.applyAction(acting.id, { type: 'fold' });
    }
  }

  protected scheduleActionTimeout(): void {
    this.clearActionTimer();

    const actingPlayerId = this.phase === 'playing' ? this.engine?.snapshot().actingPlayerId : null;
    if (!actingPlayerId) {
      return;
    }

    this.actionTimer = setTimeout(() => {
      this.actionTimer = null;
      const snapshot = this.engine?.snapshot();

      if (!snapshot || snapshot.street === 'settled' || snapshot.actingPlayerId !== actingPlayerId) {
        return;
      }

      const passive = snapshot.legalActions.find((action) => action.type === 'check')
        ?? snapshot.legalActions.find((action) => action.type === 'fold');

      if (passive) {
        this.applyAction(actingPlayerId, passive);
      }
    }, this.options.actionTimeoutMs);
  }

  protected clearActionTimer(): void {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
  }

  public resendHandState(player: RoomPlayer): void {
    if (!this.engine || this.phase !== 'playing') {
      return;
    }

    const snapshot = { ...this.engine.snapshot(), handId: this.handNumber };

    // 两手之间（已结算）只补公共快照：此时没有庄家/底牌，新手牌马上开始
    if (snapshot.street === 'settled') {
      this.sendTo(player, { type: 'stateSync', snapshot });
      return;
    }

    if (snapshot.players.some((candidate) => candidate.id === player.id)) {
      this.sendTo(player, { type: 'handStart', handId: snapshot.handId, dealerPlayerId: snapshot.dealerPlayerId! });
      this.sendTo(player, { type: 'yourHand', handId: snapshot.handId, cards: this.engine.getHoleCards(player.id) });
    }

    this.sendTo(player, { type: 'stateSync', snapshot });
  }

  private finishHand(): void {
    this.clearActionTimer();

    // autoFold 弃牌嵌套在 broadcastStateSync 里时 finishHand 会被内外各调一次，
    // 清掉旧的两手之间计时器，避免下一手被开两次
    if (this.betweenHandsTimer) {
      clearTimeout(this.betweenHandsTimer);
      this.betweenHandsTimer = null;
    }

    for (const playerState of this.engine!.snapshot().players) {
      const player = this.players.find((candidate) => candidate.id === playerState.id);
      if (player) {
        player.stack = playerState.stack;
      }
    }

    this.broadcastRoomState();
    this.betweenHandsTimer = setTimeout(() => {
      this.betweenHandsTimer = null;
      this.dropAutoFoldedPlayers();
      // dropAutoFoldedPlayers 可能已清空房间并触发 onEmpty，不要再碰引擎
      if (this.players.length === 0) {
        return;
      }
      this.startHand();
    }, this.options.betweenHandsMs);
  }

  private dropAutoFoldedPlayers(): void {
    for (const player of [...this.players]) {
      if (player.autoFold) {
        const timer = this.reconnectTimers.get(player.id);
        if (timer) {
          clearTimeout(timer);
          this.reconnectTimers.delete(player.id);
        }
        this.players.splice(this.players.indexOf(player), 1);
      }
    }

    if (this.hostId && !this.seatedPlayers().some((player) => player.id === this.hostId)) {
      this.hostId = this.seatedPlayers()[0]?.id ?? '';
    }

    if (this.players.length === 0) {
      this.onEmpty();
      return;
    }

    this.broadcastRoomState();
  }
}
