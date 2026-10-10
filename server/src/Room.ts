import { randomUUID } from 'node:crypto';

import { PokerEngine } from '../../assets/scripts/core/PokerEngine';
import { EngineEvent, PlayerAction } from '../../assets/scripts/core/types';
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
  private lastDealerIndex = -1;
  private handNumber = 0;
  private actionTimer: ReturnType<typeof setTimeout> | null = null;
  private betweenHandsTimer: ReturnType<typeof setTimeout> | null = null;

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

    if (!player) {
      return null;
    }

    player.connected = true;
    player.connection = connection;
    this.broadcastRoomState();
    return player;
  }

  public markDisconnected(playerId: string): void {
    const player = this.players.find((candidate) => candidate.id === playerId);

    if (!player) {
      return;
    }

    player.connected = false;
    player.connection = null;
    this.broadcastRoomState();
  }

  public removePlayer(playerId: string): void {
    const index = this.players.findIndex((candidate) => candidate.id === playerId);

    if (index === -1) {
      return;
    }

    this.players.splice(index, 1);

    if (this.hostId === playerId) {
      this.hostId = this.seatedPlayers()[0]?.id ?? '';
    }

    if (this.players.length === 0) {
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

    if (this.seatedPlayers().length < 2) {
      return { ok: false, code: 'bad-message', message: '至少需要 2 名玩家' };
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
    this.engine = PokerEngine.createWithPlayers(
      seated.map((player) => ({ id: player.id, name: player.nickname })),
      {
        stacks: Object.fromEntries(seated.map((player) => [player.id, player.stack])),
        initialDealerIndex: this.lastDealerIndex,
      },
    );

    const snapshot = this.engine.startHand();
    this.lastDealerIndex = Math.max(0, seated.findIndex((player) => player.id === snapshot.dealerPlayerId));
    // 引擎每手重建、handId 归零，房间里自行累计手牌序号
    this.handNumber += 1;
    this.broadcast({ type: 'handStart', handId: this.handNumber, dealerPlayerId: snapshot.dealerPlayerId! });

    for (const player of seated) {
      this.sendTo(player, { type: 'yourHand', handId: this.handNumber, cards: this.engine.getHoleCards(player.id) });
    }

    this.broadcastRoomState();
    this.broadcastStateSync();
    this.scheduleActionTimeout();
  }

  protected applyAction(playerId: string, action: PlayerAction): void {
    let events: EngineEvent[];

    try {
      events = this.engine!.act(action);
    } catch {
      const player = this.players.find((candidate) => candidate.id === playerId);
      if (player) {
        this.sendTo(player, { type: 'error', code: 'illegal-action', message: '行动不合法' });
      }
      return;
    }

    for (const event of events) {
      if (event.type === 'action-taken') {
        this.broadcast({ type: 'actionTaken', playerId: event.playerId, action: event.action, amount: event.amount });
      }
    }

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

    this.broadcastStateSync();

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

    this.broadcast({ type: 'stateSync', snapshot: { ...this.engine.snapshot(), handId: this.handNumber } });
  }

  protected scheduleActionTimeout(): void {
    // Task 6 实现行动超时；此处先占位，Task 6 替换。
  }

  protected clearActionTimer(): void {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
  }

  private finishHand(): void {
    this.clearActionTimer();

    for (const playerState of this.engine!.snapshot().players) {
      const player = this.players.find((candidate) => candidate.id === playerState.id);
      if (player) {
        player.stack = playerState.stack;
      }
    }

    this.broadcastRoomState();
    this.betweenHandsTimer = setTimeout(() => {
      this.betweenHandsTimer = null;
      this.startHand();
    }, this.options.betweenHandsMs);
  }
}
