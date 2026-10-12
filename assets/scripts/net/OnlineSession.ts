import { Card, EngineEvent, EngineSnapshot, PlayerAction } from '../core/types';
import { NetClient } from './NetClient';
import { OnlineCredentials } from './OnlineCredentials';
import { RoomStateMessage, ServerMessage } from './protocol';

export interface TableUpdate {
  events: EngineEvent[];
  snapshot: EngineSnapshot | null;
  newHand: boolean;
}

export interface OnlineSessionHandlers {
  onTableUpdate: (update: TableUpdate) => Promise<void>;
  onRoomState: (room: RoomStateMessage) => void;
  onSessionLost: (message: string) => void;
  onError?: (message: string) => void;
}

export interface OnlineSessionOptions {
  playerId: string;
  credentials: OnlineCredentials;
  handlers: OnlineSessionHandlers;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
}

const VISUAL_SEAT_IDS = ['player', 'ai-1', 'ai-2', 'ai-3', 'ai-4', 'ai-5'] as const;

export class OnlineSession {
  private readonly handlers: OnlineSessionHandlers;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private latestRoom: RoomStateMessage | null = null;
  private visualIds = new Map<string, string>();
  private handId = 0;
  private communityCount = 0;
  private pendingDealEvents: EngineEvent[] = [];
  private needsReset = false;
  private queue: Promise<void> = Promise.resolve();
  private reconnecting = false;
  private disposed = false;
  private awaitingReconnectAck = false;

  public constructor(
    private readonly client: NetClient,
    private readonly options: OnlineSessionOptions,
  ) {
    this.handlers = options.handlers;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;

    client.onMessage = (message) => this.handleMessage(message);
    client.onClose = () => {
      void this.tryReconnect();
    };
  }

  public sendAction(action: PlayerAction): void {
    this.client.send({ type: 'action', action });
  }

  public sendStartGame(): void {
    this.client.send({ type: 'startGame' });
  }

  public sendLeave(): void {
    this.disposed = true;
    this.client.onClose = null;
    this.client.send({ type: 'leaveRoom' });
    this.client.close();
  }

  public seatNames(): Map<string, string> {
    const names = new Map<string, string>();

    if (!this.latestRoom) {
      return names;
    }

    for (const seat of this.latestRoom.seats) {
      const visualId = this.visualIds.get(seat.playerId);

      if (visualId) {
        names.set(visualId, seat.playerId === this.options.playerId ? `${seat.nickname}（你）` : seat.nickname);
      }
    }

    return names;
  }

  public whenIdle(): Promise<void> {
    return this.queue;
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'joined':
        this.awaitingReconnectAck = false;
        this.handleRoomState(message.room);
        return;
      case 'roomState':
        this.handleRoomState(message.room);
        return;
      case 'handStart':
        this.handleHandStart(message.handId);
        return;
      case 'yourHand':
        this.handleYourHand(message.handId, message.cards);
        return;
      case 'stateSync':
        this.handleStateSync(message.snapshot);
        return;
      case 'actionTaken':
        this.enqueue({
          events: [{
            handId: this.handId,
            type: 'action-taken',
            playerId: this.visualId(message.playerId),
            action: message.action,
            amount: message.amount,
          }],
          snapshot: null,
          newHand: false,
        });
        return;
      case 'showdown':
        this.enqueue({
          events: message.reveals.map((reveal) => ({
            handId: message.handId,
            type: 'showdown' as const,
            playerId: this.visualId(reveal.playerId),
            cards: reveal.cards,
            handName: reveal.handName,
          })),
          snapshot: null,
          newHand: false,
        });
        return;
      case 'handResult':
        this.enqueue({
          events: message.payouts.map((payout) => ({
            handId: message.handId,
            type: 'pot-awarded' as const,
            playerId: this.visualId(payout.playerId),
            amount: payout.amount,
            handName: payout.handName,
          })),
          snapshot: null,
          newHand: false,
        });
        return;
      case 'error':
        // 服务器明确拒绝 reconnect（token 失效/房间已销毁/幽灵座位）：会话不可恢复，不再重试
        if (this.awaitingReconnectAck) {
          this.awaitingReconnectAck = false;
          this.reconnecting = false;
          this.disposed = true;
          this.handlers.onSessionLost(message.message);
          return;
        }
        this.handlers.onError?.(message.message);
        return;
    }
  }

  private handleRoomState(room: RoomStateMessage): void {
    this.latestRoom = room;
    const seatedIds = room.seats.map((seat) => seat.playerId);
    const seatedSet = new Set(seatedIds);

    if (this.visualIds.size === 0) {
      // 首次映射：从本地玩家开始按座位顺序轮转，保证牌桌几何一致
      const selfIndex = seatedIds.indexOf(this.options.playerId);
      const ordered = selfIndex === -1
        ? seatedIds
        : seatedIds.map((_, offset) => seatedIds[(selfIndex + offset) % seatedIds.length]);
      const slots = selfIndex === -1
        ? VISUAL_SEAT_IDS.filter((id) => id !== 'player')
        : VISUAL_SEAT_IDS;

      this.visualIds = new Map(
        ordered.slice(0, slots.length).map((serverId, index) => [serverId, slots[index]] as const),
      );
      this.handlers.onRoomState(room);
      return;
    }

    const next = new Map<string, string>();

    if (seatedSet.has(this.options.playerId)) {
      next.set(this.options.playerId, 'player');
    }

    // 保留既有映射：在座者视觉 id 稳定；刚离开的玩家也保留，他们迟到的 fold 等事件仍可翻译
    for (const [serverId, visualId] of this.visualIds) {
      if (!next.has(serverId)) {
        next.set(serverId, visualId);
      }
    }

    // 新入座玩家优先拿从未使用的空槽，其次复用离开者占着的槽，最后才回收离开者槽位
    for (const serverId of seatedIds) {
      if (next.has(serverId)) {
        continue;
      }

      const usedByAnyone = new Set(next.values());
      const usedBySeated = new Set(
        [...next.entries()].filter(([sid]) => seatedSet.has(sid)).map(([, vid]) => vid),
      );
      let free: string | undefined = VISUAL_SEAT_IDS.find((id) => id !== 'player' && !usedByAnyone.has(id))
        ?? VISUAL_SEAT_IDS.find((id) => id !== 'player' && !usedBySeated.has(id));

      if (!free) {
        const departed = [...next.entries()].find(([sid]) => !seatedSet.has(sid));
        if (departed) {
          free = departed[1];
          next.delete(departed[0]);
        }
      }

      if (free) {
        next.set(serverId, free);
      }
    }

    this.visualIds = next;
    this.handlers.onRoomState(room);
  }

  private handleHandStart(handId: number): void {
    this.handId = handId;
    this.communityCount = 0;
    this.needsReset = true;
    this.pendingDealEvents = [];

    for (const seat of this.latestRoom?.seats ?? []) {
      if (seat.playerId === this.options.playerId || seat.stack <= 0) {
        continue;
      }

      const visualId = this.visualIds.get(seat.playerId);

      if (!visualId) {
        continue;
      }

      this.pendingDealEvents.push(
        { handId, type: 'hole-card-dealt', playerId: visualId, faceDown: true },
        { handId, type: 'hole-card-dealt', playerId: visualId, faceDown: true },
      );
    }
  }

  private handleYourHand(handId: number, cards: Card[]): void {
    // 服务器会给 0 筹码座位发空 hand；与当前手牌不符的也一并丢弃
    if (cards.length < 2 || handId !== this.handId) {
      return;
    }

    const events: EngineEvent[] = [
      { handId, type: 'hole-card-dealt', playerId: 'player', card: cards[0], faceDown: false },
      { handId, type: 'hole-card-dealt', playerId: 'player', card: cards[1], faceDown: false },
      ...this.pendingDealEvents,
    ];
    this.pendingDealEvents = [];
    this.enqueue({ events, snapshot: null, newHand: this.takeReset() });
  }

  private handleStateSync(snapshot: EngineSnapshot): void {
    // 断线错过整手牌时本地 handId 落后：按快照重置，避免公共牌 diff 错误与 newHand 丢失
    if (snapshot.handId !== this.handId) {
      this.handId = snapshot.handId;
      this.communityCount = 0;
      this.needsReset = true;
    }

    const events: EngineEvent[] = [...this.pendingDealEvents];
    this.pendingDealEvents = [];

    for (const card of snapshot.communityCards.slice(this.communityCount)) {
      events.push({ handId: snapshot.handId, type: 'community-card-revealed', card });
    }

    this.communityCount = snapshot.communityCards.length;
    this.enqueue({ events, snapshot: this.translateSnapshot(snapshot), newHand: this.takeReset() });
  }

  private takeReset(): boolean {
    const reset = this.needsReset;
    this.needsReset = false;
    return reset;
  }

  private visualId(serverId: string): string {
    return this.visualIds.get(serverId) ?? serverId;
  }

  private translateSnapshot(snapshot: EngineSnapshot): EngineSnapshot {
    return {
      ...snapshot,
      actingPlayerId: snapshot.actingPlayerId ? this.visualId(snapshot.actingPlayerId) : null,
      dealerPlayerId: snapshot.dealerPlayerId ? this.visualId(snapshot.dealerPlayerId) : null,
      players: snapshot.players.map((player) => ({ ...player, id: this.visualId(player.id) })),
    };
  }

  private enqueue(update: TableUpdate): void {
    this.queue = this.queue
      .then(() => this.handlers.onTableUpdate(update))
      .catch((error) => console.error('[OnlineSession] onTableUpdate failed', error));
  }

  private async tryReconnect(): Promise<void> {
    if (this.reconnecting || this.disposed) {
      return;
    }

    this.reconnecting = true;

    for (let attempt = 0; attempt < this.maxReconnectAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, this.reconnectDelayMs));

      if (this.disposed) {
        this.reconnecting = false;
        return;
      }

      try {
        await this.client.connect();
      } catch {
        // 继续重试
        continue;
      }

      if (this.disposed) {
        this.client.close();
        this.reconnecting = false;
        return;
      }

      this.awaitingReconnectAck = true;
      this.client.send({
        type: 'reconnect',
        roomCode: this.options.credentials.roomCode,
        token: this.options.credentials.token,
      });
      this.reconnecting = false;
      return;
    }

    this.reconnecting = false;
    this.handlers.onSessionLost('与服务器断开连接，请重新加入房间');
  }
}
