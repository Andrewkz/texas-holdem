import { clockwiseSeatIdsFrom } from '../core/SeatOrder';
import { Card, EngineEvent, EngineSnapshot, PlayerAction } from '../core/types';
import { NetClient } from './NetClient';
import { OnlineCommands } from './OnlineCommands';
import { OnlineCredentials } from './OnlineCredentials';
import { RoomStateMessage, ServerMessage, TableParticipation, LedgerSnapshot, CommandResult, RecoveryNotice, FinalSettlement } from './protocol';
import { ServerTurnTimer, TurnCountdown, TurnCountdownState } from '../ui/TurnCountdown';
import { deriveBlindPositions, HandPositions } from '../ui/BlindPositions';

export type ConnectionStatus = 'connecting' | 'restoring' | 'connected' | 'reconnecting' | 'resume-unavailable' | 'session-taken-over';
export interface TableUpdate {
  events: EngineEvent[];
  snapshot: EngineSnapshot | null;
  newHand: boolean;
  participation: TableParticipation;
  epoch: number;
  /** Fixed roles for this hand, translated to the same visual IDs as its snapshot. */
  handPositions?: HandPositions | null;
  /** Check again after every animation/async boundary before touching the view. */
  isCurrent: () => boolean;
}
export interface OnlineSessionHandlers {
  onTableUpdate: (update: TableUpdate) => Promise<void>;
  onRoomState: (room: RoomStateMessage) => void;
  onSessionLost: (message: string) => void;
  onError?: (message: string) => void;
  onConnectionStatus?: (status: ConnectionStatus) => void;
  onInvalidate?: () => void;
  onLedger?: (ledger: LedgerSnapshot) => void;
  onCommandResult?: (result: CommandResult) => void;
  onRecoveryNotice?: (notice: RecoveryNotice) => void;
  onSessionEnded?: (settlement: FinalSettlement) => void;
}
export interface OnlineSessionOptions {
  playerId: string;
  credentials: OnlineCredentials;
  handlers: OnlineSessionHandlers;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  reconnectBudgetMs?: number;
  joinedTimeoutMs?: number;
  commandTimeoutMs?: number;
  /** Monotonic receive clock; separate from local wall-clock settings. */
  monotonicNow?: () => number;
}
// Server participants are ordered clockwise; rotate the rendered seats around the local bottom seat.
const VISUAL_SEAT_IDS = clockwiseSeatIdsFrom('player');
type UpdateData = Pick<TableUpdate, 'events' | 'snapshot' | 'newHand'>;

export class OnlineSession {
  private readonly commands: OnlineCommands;
  private readonly turnCountdown: TurnCountdown;
  private tableEpoch: string | null = null;
  private retiredEpochs = new Set<string>();
  private leaving = false;
  private readonly handlers: OnlineSessionHandlers;
  private latestRoom: RoomStateMessage | null = null;
  private visualIds = new Map<string, string>();
  private snapshotNames = new Map<string, string>();
  private participants: string[] | null = null;
  private handPositions: HandPositions | null = null;
  private handId = 0;
  private communityCount = 0;
  private pendingDealEvents: EngineEvent[] = [];
  private ownCardsDealt = false;
  private needsReset = false;
  private queue: Promise<void> = Promise.resolve();
  private reconnecting = false;
  private disposed = false;
  private awaitingReconnectAck = false;
  private epoch = 0;
  private recoveryGeneration = 0;
  private transportClosed = false;
  private snapshotSequence = 0;
  private status: ConnectionStatus = 'restoring';
  private participation: TableParticipation = 'waiting-next-hand';
  private authoritative: EngineSnapshot | null = null;
  private readonly waits = new Set<() => void>();

  public constructor(private readonly client: NetClient, private readonly options: OnlineSessionOptions) {
    this.handlers = options.handlers;
    this.turnCountdown = new TurnCountdown(options.monotonicNow);
    this.commands = new OnlineCommands(client,options.credentials.sessionId ?? '',{timeoutMs:options.commandTimeoutMs,token:options.credentials.token});
    client.onMessage = (message) => this.handleMessage(message);
    client.onClose = () => {
      this.transportClosed = true;
      if (this.disposed || this.leaving) return;
      if (this.reconnecting) { this.invalidate(); this.setStatus('reconnecting'); }
      else void this.tryReconnect();
    };
  }

  public canAct(): boolean {
    return !this.disposed && !this.leaving && this.tableEpoch !== null && this.latestRoom?.session.lifecycle !== 'ended' && this.status === 'connected' && this.participation === 'playing-hand'
      && this.authoritative?.actingPlayerId === this.options.playerId && this.authoritative.legalActions.length > 0;
  }
  public getTurnCountdown(): TurnCountdownState | null {
    const countdown = this.turnCountdown.read();
    return countdown ? { ...countdown, playerId: this.visualId(countdown.playerId) } : null;
  }
  public getHandPositions(handId: number): HandPositions | null {
    const positions = this.handPositions;
    if (this.disposed || handId !== this.handId || positions?.handId !== handId) return null;
    return {
      handId,
      dealerPlayerId: this.visualId(positions.dealerPlayerId),
      smallBlindPlayerId: this.visualId(positions.smallBlindPlayerId),
      bigBlindPlayerId: this.visualId(positions.bigBlindPlayerId),
    };
  }
  public sendAction(action: PlayerAction): void {
    if (this.canAct() && this.authoritative?.legalActions.some((legal) => legal.type === action.type)) {
      this.client.send({ type: 'action', action,sessionId:this.options.credentials.sessionId!,tableEpoch:this.tableEpoch!,handId:this.authoritative.handId });
      this.authoritative = null; // Never replay an unconfirmed action or accept a duplicate click.
    }
  }
  public sendStartGame(): void {
    if (!this.disposed && this.status === 'connected' && this.latestRoom?.phase === 'lobby') this.client.send({ type: 'startGame',sessionId:this.options.credentials.sessionId! });
  }
  public rebuy(requestId?:string):Promise<CommandResult> {return this.commands.execute('rebuy',requestId);}
  public requestEnd(requestId?:string):Promise<CommandResult> {return this.commands.execute('requestEnd',requestId);}
  public queryCommand(requestId:string):Promise<CommandResult> {return this.commands.query(requestId);}
  public retryCommand(requestId:string):Promise<CommandResult> {return this.commands.retry(requestId);}
  public async sendLeave(requestId?:string):Promise<CommandResult> {
    this.leaving=true;this.recoveryGeneration+=1;this.cancelWaits();this.invalidate();
    const result=await this.commands.execute('leaveRoom',requestId);
    this.dispose();return result;
  }
  public cancelReconnect(): void { this.dispose(); }
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reconnecting = false;
    this.recoveryGeneration += 1;
    this.invalidate();
    this.cancelWaits();
    this.commands.dispose();
    this.client.onClose = null;
    this.client.onMessage = null;
    this.client.close();
  }
  public seatNames(): Map<string, string> {
    const names = new Map<string, string>();
    for (const [id, visual] of Array.from(this.visualIds)) {
      const seat = this.latestRoom?.seats.find((entry) => entry.playerId === id);
      const name = this.snapshotNames.get(id) ?? seat?.nickname;
      if (name) names.set(visual, id === this.options.playerId ? `${name}（你）` : name);
    }
    return names;
  }
  public whenIdle(): Promise<void> { return this.queue; }
  public primeRoom(room: RoomStateMessage): void {
    if (this.latestRoom || this.disposed) return;
    this.tableEpoch=room.session.tableEpoch;
    if (room.phase === 'lobby') this.handleRoomState(room);
    else this.applyRoomMapping(room);
  }

  private handleMessage(message: ServerMessage): void {
    if (this.disposed) return;
    if ('handId' in message && this.handId>0 && message.handId<this.handId)return;
    if(message.type==='stateSync' && this.handId>0 && message.snapshot.handId<this.handId)return;
    if ('sessionId' in message && message.sessionId!==this.options.credentials.sessionId) return;
    if ('tableEpoch' in message && this.tableEpoch!==null && message.tableEpoch!==this.tableEpoch) return;
    if ('tableEpoch' in message && this.tableEpoch===null) this.tableEpoch=message.tableEpoch;
    switch (message.type) {
      case 'ledgerSync': if(message.ledger.sessionId===this.options.credentials.sessionId)this.handlers.onLedger?.(message.ledger);return;
      case 'commandResult': if(message.result.sessionId===this.options.credentials.sessionId)this.handlers.onCommandResult?.(message.result);return;
      case 'leftIdentity': this.leaving=true;this.recoveryGeneration+=1;this.cancelWaits();this.invalidate();return;
      case 'recoveryNotice':
        if(message.notice.sessionId!==this.options.credentials.sessionId)return;
        if(this.retiredEpochs.has(message.notice.tableEpoch))return;
        if(this.tableEpoch!==null && this.tableEpoch!==message.notice.tableEpoch)this.retiredEpochs.add(this.tableEpoch);
        this.tableEpoch=message.notice.tableEpoch;this.invalidate();this.handId=0;this.participants=null;this.handPositions=null;this.ownCardsDealt=false;this.communityCount=0;this.needsReset=true;this.visualIds.clear();this.snapshotNames.clear();this.setStatus(this.latestRoom?.phase==='lobby' && this.latestRoom.session.tableEpoch===message.notice.tableEpoch ? 'connected' : 'restoring');this.handlers.onRecoveryNotice?.(message.notice);return;
      case 'sessionEnded':
        if(message.settlement.sessionId!==this.options.credentials.sessionId)return;
        this.dispose();this.handlers.onSessionEnded?.(message.settlement);return;
      case 'joined':
        if (message.playerId !== this.options.playerId || message.roomCode !== this.options.credentials.roomCode) {
          this.terminate('resume-unavailable', '原座位无法恢复，请明确选择重新加入');
          return;
        }
        this.awaitingReconnectAck = false;
        this.handleRoomState(message.room);
        return;
      case 'roomState': this.handleRoomState(message.room); return;
      case 'handStart': this.handleHandStart(message.handId, message.participantIds, message.dealerPlayerId); return;
      case 'yourHand': this.handleYourHand(message.handId, message.cards); return;
      case 'stateSync': this.handleStateSync(message.snapshot, message.participation, message.turnTimer); return;
      case 'actionTaken':
        this.enqueue({ events: [{ handId: this.handId, type: 'action-taken', playerId: this.visualId(message.playerId), action: message.action, amount: message.amount }], snapshot: null, newHand: false });
        return;
      case 'showdown':
        this.enqueue({ events: message.reveals.map((reveal) => ({ handId: message.handId, type: 'showdown' as const, playerId: this.visualId(reveal.playerId), cards: reveal.cards, handName: reveal.handName })), snapshot: null, newHand: false });
        return;
      case 'handResult':
        this.enqueue({ events: message.payouts.map((payout) => ({ handId: message.handId, type: 'pot-awarded' as const, playerId: this.visualId(payout.playerId), amount: payout.amount, handName: payout.handName })), snapshot: null, newHand: false });
        return;
      case 'error':
        if(message.code==='storage-failed' || message.code==='stale-action'){this.invalidate();this.setStatus('restoring');this.handlers.onError?.(message.message);return;}
        if (message.code === 'session-taken-over') this.terminate('session-taken-over', message.message);
        else if (message.code === 'protocol-mismatch' || this.awaitingReconnectAck) this.terminate('resume-unavailable', message.message);
        else this.handlers.onError?.(message.message);
        return;
    }
  }

  private handleRoomState(room: RoomStateMessage): void {
    if(room.session.sessionId!==this.options.credentials.sessionId || this.retiredEpochs.has(room.session.tableEpoch))return;
    if(this.tableEpoch!==null && this.tableEpoch!==room.session.tableEpoch){this.retiredEpochs.add(this.tableEpoch);this.invalidate();this.handId=0;this.participants=null;this.handPositions=null;this.ownCardsDealt=false;this.communityCount=0;this.needsReset=true;this.visualIds.clear();this.snapshotNames.clear();this.setStatus('restoring');}
    this.tableEpoch=room.session.tableEpoch;
    if (this.latestRoom?.phase === 'playing' && room.phase === 'lobby') {
      this.invalidate();
      this.handId = 0;
      this.participants = null;
      this.handPositions = null;
      this.snapshotNames.clear();
      this.visualIds.clear();
    }
    this.applyRoomMapping(room);
    this.handlers.onRoomState(room);
    if (room.phase === 'lobby') this.setStatus('connected');
  }
  private applyRoomMapping(room: RoomStateMessage): void {
    this.latestRoom = room;
    if (this.participants) return; // Current hand owns its slots, including departed players.
    const ids = room.seats.map((seat) => seat.playerId);
    if (!this.visualIds.size) { this.mapParticipants(ids); return; }
    const used = new Set(this.visualIds.values());
    for (const id of ids) {
      if (this.visualIds.has(id)) continue;
      const slot = VISUAL_SEAT_IDS.find((candidate) => !used.has(candidate));
      if (slot) { this.visualIds.set(id, slot); used.add(slot); }
    }
  }
  private mapParticipants(ids: string[]): void {
    const selfIndex = ids.indexOf(this.options.playerId);
    const ordered = selfIndex < 0 ? ids : ids.map((_, index) => ids[(selfIndex + index) % ids.length]);
    this.visualIds = new Map(ordered.map((id, index) => [id, VISUAL_SEAT_IDS[index]]));
  }
  private handleHandStart(handId: number, participants: string[], dealerPlayerId: string): void {
    if (handId === this.handId && this.participants) return;
    this.invalidate();
    this.handId = handId;
    this.participants = [...participants];
    this.handPositions = deriveBlindPositions(handId, participants, dealerPlayerId);
    this.mapParticipants(participants);
    this.snapshotNames.clear();
    this.communityCount = 0;
    this.needsReset = true;
    this.ownCardsDealt = false;
    this.authoritative = null;
    this.participation = participants.indexOf(this.options.playerId) >= 0 ? 'playing-hand' : 'waiting-next-hand';
    this.pendingDealEvents = [];
    for (const id of participants) {
      if (id === this.options.playerId) continue;
      this.pendingDealEvents.push(
        { handId, type: 'hole-card-dealt', playerId: this.visualId(id), faceDown: true },
        { handId, type: 'hole-card-dealt', playerId: this.visualId(id), faceDown: true },
      );
    }
  }
  private handleYourHand(handId: number, cards: Card[]): void {
    if (cards.length !== 2 || handId !== this.handId || this.ownCardsDealt || (this.participants?.indexOf(this.options.playerId) ?? -1) < 0) return;
    this.ownCardsDealt = true;
    const events: EngineEvent[] = [
      { handId, type: 'hole-card-dealt', playerId: 'player', card: cards[0], faceDown: false },
      { handId, type: 'hole-card-dealt', playerId: 'player', card: cards[1], faceDown: false },
      ...this.pendingDealEvents,
    ];
    this.pendingDealEvents = [];
    this.enqueue({ events, snapshot: null, newHand: this.takeReset() });
  }
  private handleStateSync(snapshot: EngineSnapshot, participation: TableParticipation, timer?: ServerTurnTimer | null): void {
    if (snapshot.handId !== this.handId) {
      this.invalidate();
      this.handId = snapshot.handId;
      this.communityCount = 0;
      this.needsReset = true;
      this.participants = null;
      this.handPositions = null;
      this.mapParticipants(snapshot.players.map((player) => player.id));
    }
    for (const player of snapshot.players) this.snapshotNames.set(player.id, player.name);
    // Timing is anchored on receipt, before the animation queue can delay this snapshot.
    this.turnCountdown.sync(timer?.playerId === snapshot.actingPlayerId
      && snapshot.street !== 'settled' && snapshot.street !== 'showdown' ? timer : null, snapshot.handId);
    this.participation = participation;
    this.authoritative = null;
    const events = [...this.pendingDealEvents];
    this.pendingDealEvents = [];
    for (const card of snapshot.communityCards.slice(this.communityCount)) events.push({ handId: snapshot.handId, type: 'community-card-revealed', card });
    this.communityCount = snapshot.communityCards.length;
    this.enqueue({ events, snapshot: this.translateSnapshot(snapshot), newHand: this.takeReset() }, snapshot);
  }
  private takeReset(): boolean { const value = this.needsReset; this.needsReset = false; return value; }
  private visualId(id: string): string { return this.visualIds.get(id) ?? id; }
  private translateSnapshot(snapshot: EngineSnapshot): EngineSnapshot {
    return { ...snapshot,
      actingPlayerId: snapshot.actingPlayerId ? this.visualId(snapshot.actingPlayerId) : null,
      dealerPlayerId: snapshot.dealerPlayerId ? this.visualId(snapshot.dealerPlayerId) : null,
      players: snapshot.players.filter((player) => !this.participants || this.participants.indexOf(player.id) >= 0).map((player) => ({ ...player, id: this.visualId(player.id) })),
    };
  }
  private enqueue(data: UpdateData, authoritative?: EngineSnapshot): void {
    const epoch = this.epoch;
    const handId = this.handId;
    const sequence = authoritative ? ++this.snapshotSequence : this.snapshotSequence;
    const room = this.latestRoom?.code;
    const tableEpoch=this.tableEpoch;
    const update: TableUpdate = { ...data, epoch, participation: this.participation, handPositions: this.getHandPositions(handId),
      isCurrent: () => !this.disposed && this.epoch === epoch && this.handId === handId && this.latestRoom?.code === room && this.tableEpoch===tableEpoch };
    this.queue = this.queue.then(async () => {
      if (!update.isCurrent()) return;
      await this.handlers.onTableUpdate(update);
      if (!update.isCurrent()) return;
      if (authoritative && sequence === this.snapshotSequence) {
        this.authoritative = authoritative;
        this.setStatus('connected', true);
      }
    }).catch((error) => console.error('[OnlineSession] onTableUpdate failed', error));
  }
  private invalidate(): void {
    this.epoch += 1;
    this.turnCountdown.clear();
    this.authoritative = null;
    this.queue = Promise.resolve();
    this.pendingDealEvents = [];
    this.handlers.onInvalidate?.();
  }
  private setStatus(status: ConnectionStatus, notifyAgain = false): void {
    if (status === this.status && !notifyAgain) return;
    this.status = status;
    this.handlers.onConnectionStatus?.(status);
  }
  private terminate(status: 'resume-unavailable' | 'session-taken-over', message: string): void {
    if (this.disposed) return;
    this.setStatus(status);
    this.dispose();
    this.handlers.onSessionLost(message);
  }
  private cancelWaits(): void { for (const cancel of Array.from(this.waits)) cancel(); }
  private bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.waits.delete(cancel); };
      const cancel = () => { finish(); reject(new Error('恢复已取消')); };
      const timer = setTimeout(() => { finish(); reject(new Error('恢复超时')); }, Math.max(0, ms));
      this.waits.add(cancel);
      promise.then((value) => { finish(); resolve(value); }, (error) => { finish(); reject(error); });
    });
  }
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.waits.delete(finish); resolve(); };
      const timer = setTimeout(finish, ms);
      this.waits.add(finish);
    });
  }
  private async tryReconnect(): Promise<void> {
    if (this.reconnecting || this.disposed) return;
    this.reconnecting = true;
    const generation = ++this.recoveryGeneration;
    this.invalidate();
    this.handId = 0;
    this.participants = null;
    this.ownCardsDealt = false;
    this.communityCount = 0;
    this.needsReset = true;
    this.setStatus('reconnecting');
    const deadline = Date.now() + Math.min(this.options.reconnectBudgetMs ?? 180_000, 180_000);
    const current = () => !this.disposed && this.recoveryGeneration === generation;
    const remaining = () => Math.max(0, deadline - Date.now());
    const attempts = Math.min(this.options.maxReconnectAttempts ?? 20, 20);
    for (let attempt = 0; attempt < attempts && current() && remaining() > 0; attempt += 1) {
      const delay = Math.min((this.options.reconnectDelayMs ?? 2_000) * 2 ** attempt, 15_000, remaining());
      await this.pause(delay);
      if (!current() || !remaining()) break;
      try {
        this.transportClosed = false;
        this.handId = 0;
        this.participants = null;
        this.ownCardsDealt = false;
        this.communityCount = 0;
        this.needsReset = true;
        await this.bounded(this.client.connect(remaining()), remaining());
        if (!current()) return;
        this.awaitingReconnectAck = true;
        this.setStatus('restoring');
        const joined = this.client.waitForAdmission(Math.min(this.options.joinedTimeoutMs ?? 10_000, remaining()));
        this.client.send({ type: 'reconnect', sessionId: this.options.credentials.sessionId!, token: this.options.credentials.token });
        const admission=await this.bounded(joined, remaining());
        if(admission.type==='leftIdentity'){this.terminate('resume-unavailable','已离座，请明确选择返回原场');return;}
        if(admission.type==='sessionEnded')return;
        if (!current()) return;
        this.awaitingReconnectAck = false;
        if (this.transportClosed) throw new Error('连接已关闭');
        this.reconnecting = false;
        return;
      } catch (error) {
        this.awaitingReconnectAck = false;
        this.client.close();
        if (!current()) return;
        if ((error as { code?: string }).code === 'protocol-mismatch') {
          this.terminate('resume-unavailable', (error as Error).message); return;
        }
        this.setStatus('reconnecting');
      }
    }
    if (current()) this.terminate('resume-unavailable', '与服务器断开连接，请重新加入房间');
  }
}
