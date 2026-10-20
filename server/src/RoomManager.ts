import { normalizeBlinds, validateBlinds } from '../../assets/scripts/core/Blinds';
import { ClientMessage, ErrorCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, PROTOCOL_VERSION } from '../../assets/scripts/net/protocol';
import type { FinalSettlement } from '../../assets/scripts/net/SessionTypes';
import { Room, RoomOptions, RoomPlayer } from './Room';
import { ClientConnection } from './types';
import { MatchStore } from './session/MatchStore';
import { MemoryMatchStore } from './session/MemoryMatchStore';
import { hashToken, MatchRecord } from './session/MatchRecord';
export interface RoomManagerOptions extends RoomOptions {
  random?: () => number;
}
interface ConnectionState {
  negotiated: boolean;
  sessionId: string | null;
  playerId: string | null;
  departed?: boolean;
}
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly sessions = new Map<string, Room>();
  private readonly states = new Map<ClientConnection, ConnectionState>();
  private readonly random: () => number;
  private readonly roomOptions: RoomOptions;
  private readonly store: MatchStore<MatchRecord>;
  public constructor(options: RoomManagerOptions = {}) {
    this.random = options.random ?? Math.random;
    this.store = options.store ?? new MemoryMatchStore<MatchRecord>();
    this.roomOptions = { ...options, store: this.store };
    for (const record of this.store.loadAll()) {
      const room = new Room(record.roomCode, { ...this.roomOptions, record }, () => {
      });
      this.sessions.set(room.sessionId, room);
      if (room.lifecycle !== 'ended') {
        if (this.rooms.has(room.code))
          throw new Error('Multiple active sessions use the same room code');
        this.rooms.set(room.code, room);
      }
    }
  }
  public handleOpen(c: ClientConnection): void {
    this.states.set(c, { negotiated: false, sessionId: null, playerId: null });
  }
  public handleClose(c: ClientConnection): void {
    const state = this.states.get(c);
    this.states.delete(c);
    if (state?.sessionId && state.playerId) {
      try {
        this.sessions.get(state.sessionId)?.markDisconnected(state.playerId, c);
      }
      catch { /* failure pauses session */
      }
    }
  }
  public handleMessage(c: ClientConnection, m: ClientMessage): void {
    const state = this.states.get(c);
    if (m.type === 'hello') {
      if (!state || state.negotiated || m.protocolVersion !== PROTOCOL_VERSION) {
        this.sendError(c, 'protocol-mismatch', '联机版本不兼容，请刷新或升级页面');
        return;
      }
      state.negotiated = true;
      c.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
      return;
    }
    if (!state?.negotiated) {
      this.sendError(c, 'protocol-mismatch', '联机版本不兼容，请刷新或升级页面');
      return;
    }
    try {
      this.dispatch(c, m, state);
    }
    catch (e) {
      if (e instanceof Error && e.message === 'Session storage is paused')
        this.sendError(c, 'storage-failed', '本场保存失败，已暂停');
      else
        this.sendError(c, 'storage-failed', '操作未确认，本场已暂停，请保留凭证');
    }
  }
  private dispatch(c: ClientConnection, m: Exclude<ClientMessage, {
    type: 'hello';
  }>, state: ConnectionState): void {
    this.sweep();
    if (m.type === 'lookupRoom') {
      const room = this.rooms.get(m.roomCode.toUpperCase());
      if (!room || room.lifecycle === 'ended') {
        this.sendError(c, 'room-not-found', '房间不存在');
        return;
      }
      c.send({ type: 'roomLookup', roomCode: room.code, sessionId: room.sessionId });
      return;
    }
    if (m.type === 'createRoom' || m.type === 'joinRoom') {
      if (m.type === 'createRoom' && m.blinds !== undefined && !validateBlinds(m.blinds)) {
        this.sendError(c, 'bad-message', '盲注必须为整数，且 1 ≤ 小盲 < 大盲 ≤ 1000');
        return;
      }
      const old = Array.from(this.sessions.values()).find(r => r.admission(m.requestId));
      if (state.sessionId && !state.departed && !old) {
        this.sendError(c, 'bad-message', '请先离开当前房间');
        return;
      }
      if (old) {
        const a = old.admission(m.requestId)!;
        if ((m.type === 'createRoom' && (normalizeBlinds(m.blinds).smallBlind !== old.roomState().blinds!.smallBlind || normalizeBlinds(m.blinds).bigBlind !== old.roomState().blinds!.bigBlind)) || a.type !== m.type || a.nickname !== m.nickname || a.tokenHash !== hashToken(m.token) || (m.type === 'joinRoom' && (m.sessionId !== old.sessionId || m.roomCode.toUpperCase() !== old.code))) {
          this.sendError(c, 'request-conflict', '请求ID与原入场证明不一致');
          return;
        }
        this.admit(c, old, m.nickname, m.token, m.requestId, m.type);
        return;
      }
      if (m.type === 'createRoom') {
        const code = this.generateRoomCode();
        const room = new Room(code, { ...this.roomOptions, blinds: normalizeBlinds(m.blinds) }, () => {
        });
        const result = room.addPlayer(m.nickname, c, m.token, m.requestId, 'createRoom');
        if (result.ok === false) {
          this.sendError(c, result.code, result.message);
          return;
        }
        this.sessions.set(room.sessionId, room);
        this.rooms.set(code, room);
        this.joined(c, room, result.player, m.token, m.requestId);
        return;
      }
      const room = this.rooms.get(m.roomCode.toUpperCase());
      if (!room || room.sessionId !== m.sessionId) {
        this.sendError(c, 'room-not-found', '邀请已失效，请重新查询房间');
        return;
      }
      this.admit(c, room, m.nickname, m.token, m.requestId, 'joinRoom');
      return;
    }
    if (m.type === 'reconnect' || m.type === 'rejoin') {
      if (state.sessionId && !state.departed) {
        this.sendError(c, 'bad-message', '请先离开当前房间');
        return;
      }
      const room = this.sessions.get(m.sessionId);
      const identity = room?.identify(m.token);
      if (!room || !identity) {
        this.sendError(c, 'invalid-proof', '无法验证本场身份');
        return;
      }
      if (room.lifecycle === 'ended') {
        const settlement = room.snapshotRecord().settlement;
        if (settlement)
          c.send({ type: 'sessionEnded', settlement });
        return;
      }
      const player = m.type === 'rejoin' ? room.rejoinPlayer(m.token, m.requestId, c) : room.reconnectPlayer(m.token, c);
      if (!player) {
        if (identity.autoFold)
          this.states.set(c, { negotiated: true, sessionId: room.sessionId, playerId: identity.id, departed: true });
        if (identity.autoFold)
          c.send({ type: 'leftIdentity', sessionId: room.sessionId, playerId: identity.id });
        this.sendError(c, identity.autoFold ? 'pending-equity' : 'room-not-found', identity.autoFold ? '已离座，请在权益结清后明确返回原场' : '无法恢复座位');
        return;
      }
      this.joined(c, room, player, m.token, m.type === 'rejoin' ? m.requestId : undefined);
      return;
    }
    if (m.type === 'commandStatus' && 'token' in m && typeof m.token === 'string') {
      const target = this.sessions.get(m.sessionId);
      const identity = target?.identify(m.token);
      if (!target || !identity) {
        this.sendError(c, 'invalid-proof', '无法验证本场身份');
        return;
      }
      const receipt = target.commandStatus(identity.id, m.requestId);
      if (receipt)
        c.send({ type: 'commandResult', result: receipt });
      else
        this.sendError(c, target.paused ? 'storage-failed' : 'command-not-found', target.paused ? '保存结果待确认，请保留原请求ID等待恢复后查询' : '未找到此管理请求');
      return;
    }
    const room = state.sessionId ? this.sessions.get(state.sessionId) : undefined;
    if (!room || !state.playerId || m.sessionId !== room.sessionId) {
      this.sendError(c, 'not-in-room', '你不在此本场中');
      return;
    }
    if (m.type === 'startGame') {
      const result = room.startGame(state.playerId);
      if (result.ok === false)
        this.sendError(c, result.code, result.message);
      return;
    }
    if (m.type === 'action') {
      room.handleAction(state.playerId, m.action, m);
      return;
    }
    if (m.type === 'commandStatus') {
      const result = room.commandStatus(state.playerId, m.requestId);
      if (result)
        c.send({ type: 'commandResult', result });
      else
        this.sendError(c, room.paused ? 'storage-failed' : 'command-not-found', room.paused ? '保存结果待确认，请保留原请求ID等待恢复后查询' : '未找到此管理请求');
      return;
    }
    const result = room.command(state.playerId, m.type, m.requestId);
    c.send({ type: 'commandResult', result });
    if (m.type === 'leaveRoom' && result.status !== 'rejected') {
      c.send({ type: 'leftIdentity', sessionId: room.sessionId, playerId: state.playerId });
      room.detachConnection(state.playerId, c);
      this.states.set(c, { negotiated: true, sessionId: room.sessionId, playerId: state.playerId, departed: true });
    }
  }
  private admit(c: ClientConnection, r: Room, nickname: string, token: string, requestId: string, type: 'createRoom' | 'joinRoom'): void {
    if (r.lifecycle === 'ended') {
      const settlement = r.snapshotRecord().settlement;
      if (settlement)
        c.send({ type: 'sessionEnded', settlement });
      return;
    }
    const result = r.addPlayer(nickname, c, token, requestId, type);
    if (result.ok === false) {
      this.sendError(c, result.code, result.message);
      return;
    }
    this.joined(c, r, result.player, token, requestId);
  }
  private joined(c: ClientConnection, room: Room, player: RoomPlayer, token: string, requestId?: string): void {
    for (const [other, s] of this.states)
      if (other !== c && s.sessionId === room.sessionId && s.playerId === player.id)
        this.states.delete(other);
    this.states.set(c, { negotiated: true, sessionId: room.sessionId, playerId: player.id });
    c.send({ type: 'joined', roomCode: room.code, sessionId: room.sessionId, token, playerId: player.id, room: room.roomState(), ...(requestId ? { requestId } : {}) });
    room.broadcastRoomState();
    room.broadcastLedger();
    const notice = room.snapshotRecord().recoveryNotice;
    if (notice)
      c.send({ type: 'recoveryNotice', notice: { ...notice, tableEpoch: room.tableEpoch } });
    room.resendHandState(player);
  }
  private sweep(): void {
    for (const [code, r] of this.rooms) {
      r.expireIfNeeded();
      if (r.lifecycle === 'ended')
        this.rooms.delete(code);
    }
  }
  public roomCount(): number {
    this.sweep();
    return this.rooms.size;
  }
  public getRoom(sessionId: string): Room | undefined {
    return this.sessions.get(sessionId);
  }
  public records(): MatchRecord[] {
    return Array.from(this.sessions.values()).map(r => r.snapshotRecord());
  }
  public getSettlement(shareId: string, now = Date.now()): {
    status: 200;
    settlement: FinalSettlement;
  } | {
    status: 404 | 410;
  } {
    const settlement = this.records().map(r => r.settlement).find(s => s?.shareId === shareId);
    if (!settlement)
      return { status: 404 };
    if (now >= settlement.expiresAt)
      return { status: 410 };
    return { status: 200, settlement: publicSettlement(settlement) };
  }
  public dispose(): void {
    for (const room of this.sessions.values())
      room.dispose();
  }
  private generateRoomCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_ALPHABET[Math.floor(this.random() * ROOM_CODE_ALPHABET.length)]).join('');
      if (!this.rooms.has(code))
        return code;
    }
    throw new Error('Unable to allocate room code');
  }
  private sendError(c: ClientConnection, code: ErrorCode, message: string): void {
    c.send({ type: 'error', code, message });
  }
}
export function publicSettlement(s: FinalSettlement): FinalSettlement {
  return { sessionId: s.sessionId, shareId: s.shareId, endedAt: s.endedAt, expiresAt: s.expiresAt, reason: s.reason, recoveryNotice: s.recoveryNotice ? { sessionId: s.recoveryNotice.sessionId, tableEpoch: s.recoveryNotice.tableEpoch, checkpointVersion: s.recoveryNotice.checkpointVersion, rolledBackHandId: s.recoveryNotice.rolledBackHandId, reason: s.recoveryNotice.reason } : null, rows: s.rows.map(p => ({ playerId: p.playerId, nickname: p.nickname, rebuyCount: p.rebuyCount, totalBuyIn: p.totalBuyIn, finalChips: p.finalChips, net: p.net })) };
}
