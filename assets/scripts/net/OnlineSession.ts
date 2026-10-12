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
      case 'roomState':
      case 'joined':
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
        return;
    }
  }

  private handleRoomState(room: RoomStateMessage): void {
    this.latestRoom = room;
    const ids = room.seats.map((seat) => seat.playerId);
    const selfIndex = ids.indexOf(this.options.playerId);
    const ordered = selfIndex === -1
      ? ids
      : ids.map((_, offset) => ids[(selfIndex + offset) % ids.length]);

    this.visualIds = new Map(
      ordered.map((serverId, index) => [serverId, VISUAL_SEAT_IDS[index]] as const),
    );
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
    if (handId !== this.handId) {
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
    this.queue = this.queue.then(() => this.handlers.onTableUpdate(update));
  }

  private async tryReconnect(): Promise<void> {
    if (this.reconnecting) {
      return;
    }

    this.reconnecting = true;

    for (let attempt = 0; attempt < this.maxReconnectAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, this.reconnectDelayMs));

      try {
        await this.client.connect();
        this.client.send({
          type: 'reconnect',
          roomCode: this.options.credentials.roomCode,
          token: this.options.credentials.token,
        });
        this.reconnecting = false;
        return;
      } catch {
        // 继续重试
      }
    }

    this.reconnecting = false;
    this.handlers.onSessionLost('与服务器断开连接，请重新加入房间');
  }
}
