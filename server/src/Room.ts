import { randomBytes, randomUUID } from 'node:crypto';
import { BlindConfig, assertBlinds, normalizeBlinds } from '../../assets/scripts/core/Blinds';
import { PokerEngine } from '../../assets/scripts/core/PokerEngine';
import { EngineEvent, EngineSnapshot, PlayerAction } from '../../assets/scripts/core/types';
import { ACTION_TIMEOUT_MS, BETWEEN_HANDS_MS, ErrorCode, MAX_SEATS, RECONNECT_WINDOW_MS, RoomStateMessage, ServerMessage } from '../../assets/scripts/net/protocol';
import type { CommandResult, CommandType, EndReason, LedgerSnapshot } from '../../assets/scripts/net/SessionTypes';
import { ClientConnection } from './types';
import { SessionLedger, LedgerError } from './session/SessionLedger';
import { MatchStore } from './session/MatchStore';
import { MemoryMatchStore } from './session/MemoryMatchStore';
import { cloneRecord, hashToken, MatchRecord, validateMatchRecord } from './session/MatchRecord';
export interface RoomPlayer {
  id: string;
  nickname: string;
  token: string;
  stack: number;
  connected: boolean;
  connection: ClientConnection | null;
  autoFold: boolean;
  reconnectExpiresAt: number | null;
}
export interface RoomOptions {
  blinds?: BlindConfig;
  actionTimeoutMs?: number;
  reconnectWindowMs?: number;
  betweenHandsMs?: number;
  store?: MatchStore<MatchRecord>;
  record?: MatchRecord;
}
export type JoinResult = {
  ok: true;
  player: RoomPlayer;
} | {
  ok: false;
  code: ErrorCode;
  message: string;
};
export class Room {
  public phase: 'lobby' | 'playing' = 'lobby';
  public get hostId(): string {
    return this.record.hostId;
  }
  public readonly tableEpoch = randomUUID();
  public paused = false;
  protected readonly players: RoomPlayer[] = [];
  protected readonly options: {
    actionTimeoutMs: number;
    reconnectWindowMs: number;
    betweenHandsMs: number;
  };
  private record: MatchRecord;
  private readonly store: MatchStore<MatchRecord>;
  private engine: PokerEngine | null = null;
  private participantIds: string[] = [];
  private currentDealerPlayerId = '';
  private handSeatOrder: string[] = [];
  private endedPublished = false;
  private handNumber = 0;
  private actionTimer: ReturnType<typeof setTimeout> | null = null;
  private actionClock: { playerId: string; deadlineAt: number; durationMs: number } | null = null;
  private betweenHandsTimer: ReturnType<typeof setTimeout> | null = null;
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  public constructor(public readonly code: string, options: RoomOptions = {}, private readonly onEmpty: () => void = () => {
  }) {
    if (options.blinds !== undefined) assertBlinds(options.blinds);
    this.options = { actionTimeoutMs: options.actionTimeoutMs ?? ACTION_TIMEOUT_MS, reconnectWindowMs: options.reconnectWindowMs ?? RECONNECT_WINDOW_MS, betweenHandsMs: options.betweenHandsMs ?? BETWEEN_HANDS_MS };
    this.store = options.store ?? new MemoryMatchStore<MatchRecord>();
    const sessionId = randomUUID();
    this.record = options.record ? validateMatchRecord(options.record) : { schemaVersion: 2, blinds: normalizeBlinds(options.blinds), sessionId, revision: 0, roomCode: code, createdAt: Date.now(), ledger: SessionLedger.create(sessionId).toJSON(), credentials: [], admissions: [], commands: [], seatOrder: [], hostId: '', nextPlayerNumber: 1, lastDealerPlayerId: null, lastDealerSeatIndex: -1, handAttemptId: 0, checkpointVersion: 0, inFlightHandId: null, lifecycle: 'active', endReason: null, reconnectDeadlines: {}, allOfflineDeadline: null, recoveryNotice: null, settlement: null };
    this.syncPlayers();
    if (options.record)
      this.recover();
  }
  public get sessionId(): string {
    return this.record.sessionId;
  }
  public get lifecycle(): MatchRecord['lifecycle'] {
    return this.record.lifecycle;
  }
  public snapshotRecord(): MatchRecord {
    return cloneRecord(this.record);
  }
  public ledgerSnapshot(): LedgerSnapshot {
    return { sessionId: this.sessionId, committedHandId: this.record.ledger.committedHandId, rows: cloneRecord(this.record.ledger.participants) };
  }
  private transaction(change: (next: MatchRecord, ledger: SessionLedger) => void): void {
    if (this.paused)
      throw new Error('Session storage is paused');
    const next = cloneRecord(this.record);
    const ledger = new SessionLedger(next.ledger);
    try {
      change(next, ledger);
      next.ledger = ledger.toJSON();
      next.revision = this.record.revision + 1;
      this.store.commit(next, this.record.revision);
    }
    catch (error) {
      this.paused = true;
      this.clearTimers();
      this.broadcast({ type: 'error', code: 'storage-failed', message: '本场保存失败，已暂停，请保留本场凭证' });
      throw error;
    }
    this.record = next;
    this.syncPlayers();
  }
  private syncPlayers(): void {
    for (const p of this.record.ledger.participants) {
      let runtime = this.players.find(v => v.id === p.playerId);
      if (!runtime) {
        runtime = { id: p.playerId, nickname: p.nickname, token: '', stack: p.stack, connected: false, connection: null, autoFold: p.seatStatus !== 'seated', reconnectExpiresAt: null };
        this.players.push(runtime);
      }
      runtime.stack = p.stack;
      runtime.autoFold = p.seatStatus !== 'seated';
      runtime.reconnectExpiresAt = this.record.reconnectDeadlines[p.playerId] ?? null;
    }
  }
  private recover(): void {
    if (this.lifecycle === 'ended')
      return;
    const now = Date.now();
    const expired = this.record.allOfflineDeadline !== null && now >= this.record.allOfflineDeadline;
    this.transaction((r, l) => {
      this.rollback(r, l, expired ? 'all-offline-timeout' : 'server-restart');
      for (const p of l.toJSON().participants)
        if (p.seatStatus === 'seated' && !(p.playerId in r.reconnectDeadlines))
          r.reconnectDeadlines[p.playerId] = now + this.options.reconnectWindowMs;
      if (expired)
        this.finalizeRecord(r, l, 'all-offline-timeout');
      else if (r.lifecycle === 'ending-after-hand')
        this.finalizeRecord(r, l, (r.endReason ?? 'host-ended') as EndReason);
      else if (r.seatOrder.length === 0)
        this.finalizeRecord(r, l, 'last-player-left');
      else {
        r.lifecycle = 'all-offline-wait';
        r.allOfflineDeadline ??= now + this.options.reconnectWindowMs;
      }
    });
    this.scheduleOffline();
    for (const p of this.players)
      if (p.reconnectExpiresAt !== null)
        this.scheduleReconnect(p);
  }
  private rollback(r: MatchRecord, l: SessionLedger, reason: 'server-restart' | 'all-offline-timeout'): void {
    if (r.inFlightHandId !== null) {
      l.resolveRolledBackHand(r.inFlightHandId);
      r.recoveryNotice = { sessionId: r.sessionId, tableEpoch: this.tableEpoch, checkpointVersion: r.checkpointVersion, rolledBackHandId: r.inFlightHandId, reason };
      r.inFlightHandId = null;
    }
  }
  public addPlayer(nickname: string, connection: ClientConnection, token: string = randomUUID(), requestId: string = randomUUID(), type: 'createRoom' | 'joinRoom' = 'joinRoom'): JoinResult {
    this.expireIfNeeded();
    if (this.lifecycle === 'ended')
      return { ok: false, code: 'session-ended', message: '本场已结束' };
    const old = this.record.admissions.find(a => a.requestId === requestId);
    if (old) {
      if (old.tokenHash !== hashToken(token) || old.nickname !== nickname || old.type !== type)
        return { ok: false, code: 'request-conflict', message: '请求ID与原入场证明不一致' };
      const p = this.reconnectPlayer(token, connection);
      return p ? { ok: true, player: p } : { ok: false, code: 'pending-equity', message: '原入场身份已离座，请明确返回原场' };
    }
    if (this.record.credentials.some(c => c.tokenHash === hashToken(token)))
      return { ok: false, code: 'invalid-proof', message: '此证明已属于本场身份' };
    if (this.seatedPlayers().length >= MAX_SEATS)
      return { ok: false, code: 'room-full', message: '房间已满' };
    if (this.seatedPlayers().some(p => p.nickname === nickname))
      return { ok: false, code: 'nickname-taken', message: '昵称已被占用' };
    const id = `p${this.record.nextPlayerNumber}`;
    this.transaction((r, l) => {
      l.addParticipant(id, nickname, requestId);
      r.nextPlayerNumber++;
      r.credentials.push({ playerId: id, tokenHash: hashToken(token) });
      r.admissions.push({ requestId, type, nickname, tokenHash: hashToken(token), playerId: id });
      r.seatOrder.push(id);
      if (!r.hostId && r.seatOrder.length === 1)
        r.hostId = id;
      r.allOfflineDeadline = null;
      if (r.lifecycle === 'all-offline-wait')
        r.lifecycle = 'active';
    });
    const p = this.players.find(p => p.id === id)!;
    p.token = token;
    p.connected = true;
    p.connection = connection;
    this.scheduleOffline();
    this.resumeNextHand();
    return { ok: true, player: p };
  }
  public admission(requestId: string): MatchRecord['admissions'][number] | undefined {
    return this.record.admissions.find(a => a.requestId === requestId);
  }
  public identify(token: string): RoomPlayer | null {
    const credential = this.record.credentials.find(c => c.tokenHash === hashToken(token));
    return this.players.find(p => p.id === credential?.playerId) ?? null;
  }
  public reconnectPlayer(token: string, connection: ClientConnection): RoomPlayer | null {
    this.expireIfNeeded();
    const player = this.identify(token);
    if (!player || this.lifecycle === 'ended' || player.autoFold || (player.reconnectExpiresAt !== null && Date.now() >= player.reconnectExpiresAt))
      return null;
    this.transaction(r => {
      delete r.reconnectDeadlines[player.id];
      if (!r.hostId)
        r.hostId = player.id;
      r.allOfflineDeadline = null;
      if (r.lifecycle === 'all-offline-wait')
        r.lifecycle = r.endReason ? 'ending-after-hand' : 'active';
    });
    const previous = player.connection;
    player.connected = true;
    player.connection = connection;
    player.token = token;
    this.cancelReconnect(player.id);
    this.scheduleOffline();
    if (previous && previous !== connection) {
      previous.send({ type: 'error', code: 'session-taken-over', message: '该座位已在别处登录' });
      previous.close?.();
    }
    this.resumeNextHand();
    return player;
  }
  private resumeNextHand(): void {
    if (this.engine?.snapshot().street === 'settled' && this.lifecycle === 'active' && this.betweenHandsTimer === null && this.record.allOfflineDeadline === null) {
      this.betweenHandsTimer = setTimeout(() => {
        this.betweenHandsTimer = null;
        this.guard(() => this.startHand());
      }, this.options.betweenHandsMs);
    }
  }
  public rejoinPlayer(token: string, requestId: string, connection: ClientConnection): RoomPlayer | null {
    this.expireIfNeeded();
    const p = this.identify(token);
    if (!p)
      return null;
    const result = this.command(p.id, 'rejoin', requestId);
    connection.send({ type: 'commandResult', result });
    if (result.status !== 'committed')
      return null;
    return this.reconnectPlayer(token, connection);
  }
  public markDisconnected(playerId: string, connection?: ClientConnection): void {
    const p = this.players.find(p => p.id === playerId);
    if (!p || p.autoFold || !p.connected || (connection && p.connection !== connection) || this.lifecycle === 'ended' || this.paused)
      return;
    const deadline = Date.now() + this.options.reconnectWindowMs;
    this.transaction(r => {
      r.reconnectDeadlines[playerId] = deadline;
      if (!this.seatedPlayers().some(v => v.id !== playerId && v.connected)) {
        r.allOfflineDeadline ??= deadline;
        if (r.lifecycle === 'active')
          r.lifecycle = 'all-offline-wait';
      }
    });
    p.connected = false;
    p.connection = null;
    this.scheduleReconnect(p);
    this.scheduleOffline();
    this.broadcastRoomState();
  }
  private cancelReconnect(id: string): void {
    const timer = this.reconnectTimers.get(id);
    if (timer)
      clearTimeout(timer);
    this.reconnectTimers.delete(id);
  }
  private scheduleReconnect(p: RoomPlayer): void {
    this.cancelReconnect(p.id);
    if (p.reconnectExpiresAt === null || this.lifecycle === 'ended')
      return;
    const deadline = p.reconnectExpiresAt;
    const timer = setTimeout(() => {
      if (this.reconnectTimers.get(p.id) !== timer || p.connected || p.reconnectExpiresAt !== deadline)
        return;
      this.reconnectTimers.delete(p.id);
      if (Date.now() < deadline) {
        this.scheduleReconnect(p);
        return;
      }
      if (this.record.allOfflineDeadline !== null && Date.now() >= this.record.allOfflineDeadline) {
        this.guard(() => this.expireIfNeeded());
        return;
      }
      this.guard(() => this.removePlayer(p.id, false));
    }, Math.max(0, deadline - Date.now()));
    this.reconnectTimers.set(p.id, timer);
  }
  private scheduleOffline(): void {
    if (this.offlineTimer)
      clearTimeout(this.offlineTimer);
    this.offlineTimer = null;
    if (this.record.allOfflineDeadline === null || this.lifecycle === 'ended')
      return;
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      if (this.record.allOfflineDeadline !== null && Date.now() < this.record.allOfflineDeadline) {
        this.scheduleOffline();
        return;
      }
      this.guard(() => this.expireIfNeeded());
    }, Math.max(0, this.record.allOfflineDeadline - Date.now()));
  }
  public expireIfNeeded(): void {
    if (this.lifecycle === 'ended' || this.paused || this.record.allOfflineDeadline === null || Date.now() < this.record.allOfflineDeadline)
      return;
    this.transaction((r, l) => {
      this.rollback(r, l, 'all-offline-timeout');
      this.finalizeRecord(r, l, 'all-offline-timeout');
    });
    this.engine = null;
    this.phase = 'lobby';
    this.clearTimers();
    this.publishEnded();
  }
  public command(playerId: string, command: CommandType, requestId: string): CommandResult {
    this.expireIfNeeded();
    const fingerprint = JSON.stringify({ command });
    const old = this.record.commands.find(c => c.playerId === playerId && c.result.requestId === requestId);
    if (old) {
      if (old.fingerprint !== fingerprint)
        return { sessionId: this.sessionId, requestId, command, status: 'rejected', code: 'request-conflict', message: '请求ID已用于其他命令' };
      return cloneRecord(old.result);
    }
    let result: CommandResult = { sessionId: this.sessionId, requestId, command, status: 'committed' };
    this.transaction((r, l) => {
      try {
        if (r.lifecycle === 'ended')
          throw new Error('session-ended');
        if (command === 'rebuy') {
          l.queueRebuy(playerId, requestId);
          result.status = 'pending';
        }
        if (command === 'requestEnd') {
          if (r.hostId !== playerId)
            throw new Error('not-host');
          r.endReason = 'host-ended';
          r.lifecycle = 'ending-after-hand';
          this.cancelRebuys(r, l);
          if (r.inFlightHandId === null)
            this.finalizeRecord(r, l, 'host-ended');
        }
        if (command === 'leaveRoom')
          this.departRecord(r, l, playerId, true);
        if (command === 'rejoin') {
          if (r.seatOrder.length >= MAX_SEATS)
            throw new Error('room-full');
          l.rejoin(playerId);
          if (!r.seatOrder.includes(playerId))
            r.seatOrder.push(playerId);
          delete r.reconnectDeadlines[playerId];
        }
      }
      catch (e) {
        result = { ...result, status: 'rejected', code: e instanceof LedgerError ? e.code : e instanceof Error ? e.message : 'bad-message', message: e instanceof Error ? e.message : '请求失败' };
      }
      r.commands.push({ playerId, fingerprint, result: cloneRecord(result) });
    });
    if (result.status !== 'rejected') {
      if (command === 'leaveRoom')
        this.afterDeparture(playerId);
      if (this.lifecycle === 'ended') {
        this.clearTimers();
        this.publishEnded();
      }
      else {
        this.broadcastRoomState();
        this.broadcastLedger();
      }
    }
    return result;
  }
  public commandStatus(playerId: string, requestId: string): CommandResult | null {
    return cloneRecord(this.record.commands.find(c => c.playerId === playerId && c.result.requestId === requestId)?.result ?? null);
  }
  private departRecord(r: MatchRecord, l: SessionLedger, id: string, explicit: boolean): void {
    for (const requestId of l.cancelPendingRebuys(id))
      this.resolveReceipt(r, requestId, 'rejected', 'left-before-rebuy');
    const inHand = r.inFlightHandId !== null && this.participantIds.includes(id);
    l.requestDeparture(id, inHand ? r.inFlightHandId : null);
    r.seatOrder = r.seatOrder.filter(p => p !== id);
    delete r.reconnectDeadlines[id];
    if (r.hostId === id)
      r.hostId = r.seatOrder.find(pid => this.players.find(p => p.id === pid)?.connected) ?? '';
    if (!r.hostId && !r.seatOrder.some(pid => r.reconnectDeadlines[pid] !== undefined && r.reconnectDeadlines[pid] > Date.now()))
      r.hostId = r.seatOrder.find(pid => this.players.find(p => p.id === pid)?.connected) ?? '';
    if (r.seatOrder.length > 0 && !r.seatOrder.some(pid => this.players.find(p => p.id === pid)?.connected)) {
      r.allOfflineDeadline ??= Date.now() + this.options.reconnectWindowMs;
      if (r.lifecycle === 'active')
        r.lifecycle = 'all-offline-wait';
    }
    if (explicit && r.seatOrder.length === 0) {
      r.lifecycle = 'ending-after-hand';
      r.endReason = 'last-player-left';
      r.allOfflineDeadline = null;
      if (r.inFlightHandId === null)
        this.finalizeRecord(r, l, 'last-player-left');
    }
  }
  public removePlayer(id: string, explicit = true): void {
    if (this.lifecycle === 'ended' || this.paused)
      return;
    this.transaction((r, l) => this.departRecord(r, l, id, explicit));
    this.afterDeparture(id);
    if (this.record.settlement) {
      this.clearTimers();
      this.publishEnded();
    }
    else {
      this.broadcastRoomState();
      this.broadcastLedger();
    }
  }
  private afterDeparture(id: string): void {
    const p = this.players.find(p => p.id === id);
    if (!p)
      return;
    this.cancelReconnect(id);
    // Keep its connection until the manager has delivered the leave receipt / final snapshot.
    p.connected = false;
    this.scheduleOffline();
    if (this.engine && this.participantIds.includes(id) && this.engine.snapshot().street !== 'settled') {
      const previousActor = this.engine.snapshot().actingPlayerId;
      const events = this.engine.forceFoldPlayer(id);
      if (events.length > 0)
        this.processEngineEvents(events, previousActor);
    }
  }
  private cancelRebuys(r: MatchRecord, l: SessionLedger): void {
    for (const requestId of l.cancelPendingRebuys())
      this.resolveReceipt(r, requestId, 'rejected', 'session-ending');
  }
  private resolveReceipt(r: MatchRecord, id: string, status: CommandResult['status'], code?: string): void {
    const c = r.commands.find(c => c.result.requestId === id && c.result.command === 'rebuy');
    if (c)
      c.result = { ...c.result, status, ...(code ? { code } : {}) };
  }
  private finalizeRecord(r: MatchRecord, l: SessionLedger, reason: EndReason): void {
    if (r.settlement)
      return;
    if (r.inFlightHandId !== null)
      throw new Error('Unsettled hand cannot finalize');
    this.cancelRebuys(r, l);
    l.assertConserved();
    const endedAt = Date.now();
    const rows = l.toJSON().participants.map(p => ({ playerId: p.playerId, nickname: p.nickname, rebuyCount: p.rebuyCount, totalBuyIn: p.totalBuyIn, finalChips: p.stack + p.releasedChips, net: p.stack + p.releasedChips - p.totalBuyIn }));
    if (rows.reduce((sum, p) => sum + p.net, 0) !== 0)
      throw new Error('Final chips not conserved');
    r.lifecycle = 'ended';
    r.endReason = reason;
    r.allOfflineDeadline = null;
    r.reconnectDeadlines = {};
    r.settlement = { sessionId: r.sessionId, shareId: randomBytes(24).toString('base64url'), endedAt, expiresAt: endedAt + 30 * 86400000, reason, recoveryNotice: cloneRecord(r.recoveryNotice), rows };
  }
  private publishEnded(): void {
    if (!this.record.settlement || this.endedPublished)
      return;
    this.endedPublished = true;
    this.broadcast({ type: 'sessionEnded', settlement: cloneRecord(this.record.settlement) });
    this.onEmpty();
  }
  public detachConnection(id: string, connection: ClientConnection): void {
    const p = this.players.find(p => p.id === id);
    if (p?.connection === connection)
      p.connection = null;
  }
  public roomState(): RoomStateMessage {
    return { code: this.code, blinds: normalizeBlinds(this.record.blinds), phase: this.phase, hostId: this.hostId, seats: this.seatedPlayers().map(p => ({ playerId: p.id, nickname: p.nickname, stack: p.stack, connected: p.connected })), session: { sessionId: this.sessionId, tableEpoch: this.tableEpoch, lifecycle: this.lifecycle, checkpointVersion: this.record.checkpointVersion, allOfflineDeadline: this.record.allOfflineDeadline } };
  }
  public broadcastRoomState(): void {
    this.broadcast({ type: 'roomState', room: this.roomState() });
  }
  public broadcastLedger(): void {
    this.broadcast({ type: 'ledgerSync', ledger: this.ledgerSnapshot() });
  }
  protected seatedPlayers(): RoomPlayer[] {
    return this.record.seatOrder.map(id => this.players.find(p => p.id === id)!).filter(Boolean);
  }
  protected broadcast(message: ServerMessage): void {
    for (const p of this.players)
      p.connection?.send(message);
  }
  protected sendTo(player: RoomPlayer, message: ServerMessage): void {
    player.connection?.send(message);
  }
  public startGame(id: string): {
    ok: true;
  } | {
    ok: false;
    code: ErrorCode;
    message: string;
  } {
    if (this.paused)
      return { ok: false, code: 'storage-failed', message: '本场已暂停' };
    if (id !== this.hostId)
      return { ok: false, code: 'not-host', message: '只有房主可以开始游戏' };
    if (this.phase !== 'lobby' || this.lifecycle !== 'active')
      return { ok: false, code: 'bad-message', message: '本场暂不可开始' };
    if (this.record.ledger.participants.filter(p => p.seatStatus === 'seated' && (p.stack > 0 || p.pendingRebuyRequestId !== null)).length < 2)
      return { ok: false, code: 'bad-message', message: '至少需要2名有筹码的玩家' };
    this.startHand();
    return { ok: true };
  }
  public handleAction(id: string, action: PlayerAction, scope?: {
    sessionId: string;
    tableEpoch: string;
    handId: number;
  }): void {
    const p = this.players.find(p => p.id === id);
    if (this.paused || this.lifecycle === 'ended')
      return;
    if (scope && (scope.sessionId !== this.sessionId || scope.tableEpoch !== this.tableEpoch || scope.handId !== this.handNumber)) {
      p?.connection?.send({ type: 'error', code: 'stale-action', message: '牌桌已更新，请等待同步' });
      return;
    }
    if (!p || !this.engine || this.phase !== 'playing') {
      p?.connection?.send({ type: 'error', code: 'game-not-started', message: '牌局尚未开始' });
      return;
    }
    if (this.engine.snapshot().actingPlayerId !== id || p.autoFold) {
      this.sendTo(p, { type: 'error', code: 'not-your-turn', message: '还没轮到你行动' });
      return;
    }
    this.applyAction(id, action);
  }
  protected startHand(): void {
    if (this.paused || this.lifecycle !== 'active' || this.record.allOfflineDeadline !== null)
      return;
    const candidateLedger = new SessionLedger(this.record.ledger);
    candidateLedger.applyPendingRebuys(this.record.handAttemptId + 1);
    const willPlay = candidateLedger.toJSON().participants.filter(p => p.seatStatus === 'seated' && p.stack > 0).length >= 2;
    const seated = this.seatedPlayers();
    if (!willPlay) {
      this.phase = 'lobby';
      this.engine = null;
      this.broadcastRoomState();
      return;
    }
    this.transaction((r, l) => {
      for (const id of l.applyPendingRebuys(r.handAttemptId + 1))
        this.resolveReceipt(r, id, 'committed');
      r.handAttemptId++;
      r.inFlightHandId = r.handAttemptId;
    });
    this.broadcastLedger();
    this.handNumber = this.record.handAttemptId;
    this.phase = 'playing';
    // 按玩家 id 追踪庄家，避免有人离座后数组下标漂移导致轮转错位；
    // 庄家本人离席（id 找不到）时，其继任者在 splice 后的新数组中下标恰好前移一位，
    // 传"原座位号 - 1"让引擎的 nextPlayingIndex 落到正确的下一位
    let initialDealerIndex = -1;
    if (this.record.lastDealerPlayerId) {
      const byId = seated.findIndex((player) => player.id === this.record.lastDealerPlayerId);
      initialDealerIndex = byId !== -1
        ? byId
        : (this.record.lastDealerSeatIndex > 0 ? this.record.lastDealerSeatIndex - 1 : -1);
    }
    let snapshot: EngineSnapshot;
    try {
      this.engine = PokerEngine.createWithPlayers(seated.map((player) => ({ id: player.id, name: player.nickname })), {
        stacks: Object.fromEntries(seated.map((player) => [player.id, player.stack])),
        initialDealerIndex,
        blinds: normalizeBlinds(this.record.blinds),
      });
      snapshot = this.engine.startHand();
    }
    catch (error) {
      // 兜底：引擎开局失败不能让定时器回调里的异常击垮进程，回退大厅
      console.error(error);
      this.transaction(r => {
        r.inFlightHandId = null;
      });
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
      ?? this.record.lastDealerPlayerId
      ?? seated[0].id;
    // 引擎每手重建、handId 归零，房间里自行累计手牌序号
    this.participantIds = seated.filter(player => this.engine!.getHoleCards(player.id).length === 2).map(player => player.id);
    this.currentDealerPlayerId = dealerPlayerId;
    this.handSeatOrder = seated.map(p => p.id);
    this.broadcast({ type: 'handStart', sessionId: this.sessionId, tableEpoch: this.tableEpoch, handId: this.handNumber, dealerPlayerId, participantIds: [...this.participantIds] });
    for (const player of seated.filter(candidate => this.participantIds.includes(candidate.id))) {
      this.sendTo(player, { type: 'yourHand', sessionId: this.sessionId, tableEpoch: this.tableEpoch, handId: this.handNumber, cards: this.engine.getHoleCards(player.id) });
    }
    if (snapshot.street === 'settled') {
      if (this.finishHand()) {
        this.broadcastStateSync();
        this.broadcastSettlementEvents(settledEvents);
        if (this.record.settlement)
          this.publishEnded();
      }
      return;
    }
    this.broadcastRoomState();
    this.scheduleActionTimeout();
    this.broadcastStateSync();
  }
  private broadcastSettlementEvents(events: EngineEvent[]): void {
    const reveals = events.filter((event): event is Extract<EngineEvent, {
      type: 'showdown';
    }> => event.type === 'showdown');
    if (reveals.length > 0) {
      this.broadcast({
        type: 'showdown', sessionId: this.sessionId, tableEpoch: this.tableEpoch,
        handId: this.handNumber,
        reveals: reveals.map((event) => ({ playerId: event.playerId, cards: event.cards, handName: event.handName })),
      });
    }
    const payouts = events.filter((event): event is Extract<EngineEvent, {
      type: 'pot-awarded';
    }> => event.type === 'pot-awarded');
    if (payouts.length > 0) {
      this.broadcast({
        type: 'handResult', sessionId: this.sessionId, tableEpoch: this.tableEpoch,
        handId: this.handNumber,
        payouts: payouts.map((event) => ({ playerId: event.playerId, amount: event.amount, handName: event.handName })),
      });
    }
  }
  protected applyAction(playerId: string, action: PlayerAction): void {
    let events: EngineEvent[];
    try {
      events = this.engine!.act(action);
    }
    catch (error) {
      const player = this.players.find((candidate) => candidate.id === playerId);
      if (player) {
        if (error instanceof Error && error.message === 'Illegal action') {
          this.sendTo(player, { type: 'error', code: 'illegal-action', message: '行动不合法' });
        }
        else {
          console.error(error);
          this.sendTo(player, { type: 'error', code: 'bad-message', message: '服务器内部错误' });
        }
      }
      return;
    }
    this.processEngineEvents(events);
  }
  private processEngineEvents(events: EngineEvent[], previousActor?: string | null): void {
    for (const event of events) {
      if (event.type === 'action-taken') {
        this.broadcast({ type: 'actionTaken', sessionId: this.sessionId, tableEpoch: this.tableEpoch, handId: this.handNumber, playerId: event.playerId, action: event.action, amount: event.amount });
      }
    }
    // stateSync 先于结算广播：客户端靠它 diff 出公共牌翻开事件，
    // all-in 跑码（单次 act 内结算）时牌面必须先于摊牌/派彩出现
    if (this.engine!.snapshot().street === 'settled') {
      if (this.finishHand()) {
        this.broadcastStateSync();
        this.broadcastSettlementEvents(events);
        if (this.record.settlement)
          this.publishEnded();
      }
    }
    else {
      if (previousActor === undefined || this.engine!.snapshot().actingPlayerId !== previousActor)
        this.scheduleActionTimeout();
      // Establish this actor's clock before sending the snapshot. Auto-fold may recurse
      // inside this broadcast; the outer call must not reset the new actor afterwards.
      this.broadcastStateSync();
    }
  }
  protected broadcastStateSync(): void {
    if (!this.engine || this.paused) {
      return;
    }
    const snapshot = { ...this.engine.snapshot(), handId: this.handNumber };
    for (const player of this.seatedPlayers())
      this.sendStateSync(player, snapshot);
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
    if (!actingPlayerId || this.paused || this.lifecycle === 'ended') {
      return;
    }
    const clock = { playerId: actingPlayerId, deadlineAt: Date.now() + this.options.actionTimeoutMs, durationMs: this.options.actionTimeoutMs };
    this.actionClock = clock;
    const expire = () => {
      if (this.actionClock !== clock)
        return;
      this.actionTimer = null;
      if (Date.now() < clock.deadlineAt) {
        this.actionTimer = setTimeout(expire, clock.deadlineAt - Date.now());
        return;
      }
      const snapshot = this.engine?.snapshot();
      if (this.paused || this.lifecycle === 'ended' || !snapshot || snapshot.street === 'settled' || snapshot.actingPlayerId !== actingPlayerId) {
        this.actionClock = null;
        return;
      }
      const passive = snapshot.legalActions.find((action) => action.type === 'check')
        ?? snapshot.legalActions.find((action) => action.type === 'fold');
      if (passive) {
        this.guard(() => this.applyAction(actingPlayerId, passive));
      }
    };
    this.actionTimer = setTimeout(expire, this.options.actionTimeoutMs);
  }
  protected clearActionTimer(): void {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    this.actionClock = null;
  }
  private sendStateSync(player: RoomPlayer, snapshot: EngineSnapshot): void {
    const participating = this.participantIds.includes(player.id);
    this.sendTo(player, {
      type: 'stateSync', sessionId: this.sessionId, tableEpoch: this.tableEpoch,
      participation: participating ? 'playing-hand' : 'waiting-next-hand',
      snapshot: { ...snapshot, legalActions: participating && snapshot.actingPlayerId === player.id ? snapshot.legalActions : [] },
      turnTimer: !this.paused && snapshot.street !== 'settled' && this.actionClock?.playerId === snapshot.actingPlayerId
        ? { ...this.actionClock, serverNow: Date.now() }
        : null,
    });
  }
  public resendHandState(player: RoomPlayer): void {
    if (!this.engine || this.phase !== 'playing')
      return;
    const snapshot = { ...this.engine.snapshot(), handId: this.handNumber };
    this.sendTo(player, { type: 'handStart', sessionId: this.sessionId, tableEpoch: this.tableEpoch, handId: this.handNumber,
      dealerPlayerId: this.currentDealerPlayerId, participantIds: [...this.participantIds] });
    if (this.participantIds.includes(player.id)) {
      this.sendTo(player, { type: 'yourHand', sessionId: this.sessionId, tableEpoch: this.tableEpoch, handId: this.handNumber, cards: this.engine.getHoleCards(player.id) });
    }
    this.sendStateSync(player, snapshot);
  }
  private finishHand(): boolean {
    if (this.paused || !this.engine || this.record.inFlightHandId !== this.handNumber || this.engine.snapshot().street !== 'settled')
      return false;
    this.clearActionTimer();
    if (this.betweenHandsTimer)
      clearTimeout(this.betweenHandsTimer);
    this.betweenHandsTimer = null;
    const stacks = Object.fromEntries(this.engine.snapshot().players.filter(p => this.participantIds.includes(p.id)).map(p => [p.id, p.stack]));
    this.transaction((r, l) => {
      l.settleHand(this.handNumber, stacks);
      r.inFlightHandId = null;
      r.checkpointVersion++;
      r.lastDealerPlayerId = this.currentDealerPlayerId;
      r.lastDealerSeatIndex = r.seatOrder.indexOf(this.currentDealerPlayerId);
      if (r.lastDealerSeatIndex === -1) {
        const dealerIndex = this.handSeatOrder.indexOf(this.currentDealerPlayerId);
        const rotated = this.handSeatOrder.slice(dealerIndex + 1).concat(this.handSeatOrder.slice(0, dealerIndex + 1));
        const successor = rotated.find(id => r.seatOrder.includes(id));
        r.lastDealerSeatIndex = successor ? r.seatOrder.indexOf(successor) : 0;
      }
      if (r.lifecycle === 'ending-after-hand')
        this.finalizeRecord(r, l, (r.endReason ?? 'host-ended') as EndReason);
    });
    this.broadcastRoomState();
    this.broadcastLedger();
    if (this.lifecycle === 'ended') {
      this.clearTimers();
      return true;
    }
    if (this.record.allOfflineDeadline === null)
      this.betweenHandsTimer = setTimeout(() => {
        this.betweenHandsTimer = null;
        this.guard(() => this.startHand());
      }, this.options.betweenHandsMs);
    return true;
  }
  private clearTimers(): void {
    this.clearActionTimer();
    if (this.betweenHandsTimer)
      clearTimeout(this.betweenHandsTimer);
    if (this.offlineTimer)
      clearTimeout(this.offlineTimer);
    this.betweenHandsTimer = null;
    this.offlineTimer = null;
    for (const t of this.reconnectTimers.values())
      clearTimeout(t);
    this.reconnectTimers.clear();
  }
  private guard(operation: () => void): void {
    try {
      operation();
    }
    catch { /* transaction already pauses the affected session and reports failure */
    }
  }
  public dispose(): void {
    this.clearTimers();
  }
}
