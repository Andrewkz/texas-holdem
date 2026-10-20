import { createHash } from 'node:crypto';
import { BlindConfig, DEFAULT_BLINDS, validateBlinds } from '../../../assets/scripts/core/Blinds';
import { SessionLedger, type LedgerData } from './SessionLedger';
import type { CommandResult, FinalSettlement, RecoveryNotice, SessionLifecycle } from '../../../assets/scripts/net/SessionTypes';
export interface StoredCredential {
  playerId: string;
  tokenHash: string;
}
export interface AdmissionReceipt {
  requestId: string;
  type: 'createRoom' | 'joinRoom';
  nickname: string;
  tokenHash: string;
  playerId: string;
}
export interface StoredCommand {
  playerId: string;
  fingerprint: string;
  result: CommandResult;
}
export interface MatchRecord {
  schemaVersion: 1 | 2;
  /** Absent only on strict legacy v1 input; all new records use v2. */
  blinds?: BlindConfig;
  sessionId: string;
  revision: number;
  roomCode: string;
  createdAt: number;
  ledger: LedgerData;
  credentials: StoredCredential[];
  admissions: AdmissionReceipt[];
  commands: StoredCommand[];
  seatOrder: string[];
  hostId: string;
  nextPlayerNumber: number;
  lastDealerPlayerId: string | null;
  lastDealerSeatIndex: number;
  handAttemptId: number;
  checkpointVersion: number;
  inFlightHandId: number | null;
  lifecycle: SessionLifecycle;
  endReason: string | null;
  reconnectDeadlines: Record<string, number>;
  allOfflineDeadline: number | null;
  recoveryNotice: RecoveryNotice | null;
  settlement: FinalSettlement | null;
}
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}
/** Reject unknown persisted fields so private cards, sockets and raw credentials cannot enter the store. */
export function validateMatchRecord(raw: unknown): MatchRecord {
  if (!isObject(raw))
    throw new Error('Invalid match record');
  const fields = ['schemaVersion', 'sessionId', 'revision', 'roomCode', 'createdAt', 'ledger', 'credentials', 'admissions', 'commands', 'seatOrder', 'hostId', 'nextPlayerNumber', 'lastDealerPlayerId', 'lastDealerSeatIndex', 'handAttemptId', 'checkpointVersion', 'inFlightHandId', 'lifecycle', 'endReason', 'reconnectDeadlines', 'allOfflineDeadline', 'recoveryNotice', 'settlement'];
  if (raw.schemaVersion === 1) exact(raw, fields);
  else if (raw.schemaVersion === 2) {
    exact(raw, [...fields, 'blinds']);
    if (!validateBlinds(raw.blinds)) throw new Error('Invalid persisted blinds');
    exact(raw.blinds as unknown as Record<string, unknown>, ['smallBlind', 'bigBlind']);
  } else throw new Error('Unsupported match schema');
  if ((raw.schemaVersion !== 1 && raw.schemaVersion !== 2) || !id(raw.sessionId) || !id(raw.roomCode) || !integer(raw.revision, 1)
    || !integer(raw.createdAt) || !integer(raw.nextPlayerNumber, 1) || !integer(raw.handAttemptId)
    || !integer(raw.checkpointVersion) || !integer(raw.lastDealerSeatIndex, -1)
    || (raw.lastDealerPlayerId !== null && !id(raw.lastDealerPlayerId)) || typeof raw.hostId !== 'string'
    || !nullableInteger(raw.inFlightHandId, 1) || !nullableInteger(raw.allOfflineDeadline)
    || !['active', 'ending-after-hand', 'all-offline-wait', 'ended'].includes(raw.lifecycle as string)
    || (raw.endReason !== null && !id(raw.endReason)))
    throw new Error('Invalid match fields');
  if (!isObject(raw.ledger))
    throw new Error('Invalid ledger');
  exact(raw.ledger, ['sessionId', 'committedHandId', 'participants', 'entries', 'appliedHands']);
  if (!Array.isArray(raw.ledger.participants) || !Array.isArray(raw.ledger.entries) || !Array.isArray(raw.ledger.appliedHands))
    throw new Error('Invalid ledger collections');
  for (const p of raw.ledger.participants) {
    if (!isObject(p))
      throw new Error('Invalid ledger row');
    exact(p, ['playerId', 'nickname', 'seatStatus', 'totalBuyIn', 'rebuyCount', 'stack', 'releasedChips', 'pendingDepartureHandId', 'pendingRebuyRequestId']);
  }
  for (const e of raw.ledger.entries) {
    if (!isObject(e))
      throw new Error('Invalid ledger entry');
    exact(e, ['id', 'playerId', 'type', 'amount', 'handId', 'requestId']);
  }
  for (const h of raw.ledger.appliedHands) {
    if (!isObject(h))
      throw new Error('Invalid ledger hand');
    exact(h, ['handId', 'stacks']);
  }
  const ledger = new SessionLedger(raw.ledger as unknown as LedgerData).toJSON();
  if (ledger.sessionId !== raw.sessionId || ledger.committedHandId > (raw.handAttemptId as number)
    || (raw.inFlightHandId !== null && (raw.inFlightHandId !== raw.handAttemptId || raw.inFlightHandId <= ledger.committedHandId)))
    throw new Error('Invalid match hand boundary');
  const players = new Set(ledger.participants.map(p => p.playerId));
  if (raw.checkpointVersion !== ledger.appliedHands.length || ledger.participants.some(p => p.pendingDepartureHandId !== null && p.pendingDepartureHandId !== raw.inFlightHandId))
    throw new Error('Invalid checkpoint controls');
  if (raw.lastDealerPlayerId !== null && !players.has(raw.lastDealerPlayerId as string) || raw.lastDealerSeatIndex as number >= 6)
    throw new Error('Invalid dealer identity');
  if (raw.endReason !== null && !['host-ended', 'last-player-left', 'all-offline-timeout'].includes(raw.endReason as string) || raw.lifecycle === 'active' && (raw.endReason !== null || raw.allOfflineDeadline !== null) || raw.lifecycle === 'all-offline-wait' && raw.allOfflineDeadline === null || raw.lifecycle === 'ending-after-hand' && !['host-ended', 'last-player-left'].includes(raw.endReason as string) || raw.lifecycle === 'ended' && (raw.endReason === null || raw.allOfflineDeadline !== null || Object.keys(raw.reconnectDeadlines as object).length > 0))
    throw new Error('Invalid lifecycle controls');
  if (!Array.isArray(raw.seatOrder) || raw.seatOrder.length > 6 || new Set(raw.seatOrder).size !== raw.seatOrder.length
    || !raw.seatOrder.every(p => typeof p === 'string' && players.has(p)) || !Array.isArray(raw.credentials)
    || !Array.isArray(raw.admissions) || !Array.isArray(raw.commands) || !isObject(raw.reconnectDeadlines))
    throw new Error('Invalid match collections');
  if (raw.seatOrder.length !== ledger.participants.filter(p => p.seatStatus === 'seated').length || ledger.participants.some(p => (p.seatStatus === 'seated') !== (raw.seatOrder as string[]).includes(p.playerId)) || (raw.hostId !== '' && !raw.seatOrder.includes(raw.hostId)) || ledger.participants.some(p => !/^p[1-9][0-9]*$/.test(p.playerId) || Number(p.playerId.slice(1)) >= (raw.nextPlayerNumber as number)))
    throw new Error('Invalid seat identities');
  for (const c of raw.credentials) {
    if (!isObject(c))
      throw new Error('Invalid credential');
    exact(c, ['playerId', 'tokenHash']);
    if (!players.has(c.playerId as string) || typeof c.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(c.tokenHash))
      throw new Error('Invalid credential');
  }
  if (new Set(raw.credentials.map(c => (c as StoredCredential).playerId)).size !== raw.credentials.length || raw.credentials.length !== players.size || new Set(raw.credentials.map(c => (c as StoredCredential).tokenHash)).size !== raw.credentials.length)
    throw new Error('Invalid credential identities');
  const admissionIds = new Set<string>();
  for (const a of raw.admissions) {
    if (!isObject(a))
      throw new Error('Invalid admission');
    exact(a, ['requestId', 'type', 'nickname', 'tokenHash', 'playerId']);
    if (!id(a.requestId) || admissionIds.has(a.requestId) || !['createRoom', 'joinRoom'].includes(a.type as string) || !id(a.nickname)
      || !players.has(a.playerId as string) || !raw.credentials.some(c => (c as StoredCredential).playerId === a.playerId && (c as StoredCredential).tokenHash === a.tokenHash))
      throw new Error('Invalid admission');
    admissionIds.add(a.requestId as string);
    if (ledger.participants.find(p => p.playerId === a.playerId)?.nickname !== a.nickname)
      throw new Error('Admission nickname mismatch');
  }
  if (raw.admissions.length !== players.size || new Set(raw.admissions.map(a => (a as AdmissionReceipt).playerId)).size !== players.size || raw.admissions.some(a => !ledger.entries.some(e => e.type === 'initial' && e.playerId === (a as AdmissionReceipt).playerId && e.requestId === (a as AdmissionReceipt).requestId)))
    throw new Error('Invalid admission history');
  const commandIds = new Set<string>();
  for (const c of raw.commands) {
    if (!isObject(c))
      throw new Error('Invalid command');
    exact(c, ['playerId', 'fingerprint', 'result']);
    if (!players.has(c.playerId as string) || !id(c.fingerprint) || !isObject(c.result))
      throw new Error('Invalid command');
    const result = c.result;
    allowed(result, ['sessionId', 'requestId', 'command', 'status', 'code', 'message'], ['sessionId', 'requestId', 'command', 'status']);
    const key = `${c.playerId}:${result.requestId}`;
    if (!id(result.requestId) || result.sessionId !== raw.sessionId || !['pending', 'committed', 'rejected'].includes(result.status as string) || !['rebuy', 'requestEnd', 'leaveRoom', 'rejoin'].includes(result.command as string) || commandIds.has(key) || c.fingerprint !== JSON.stringify({ command: result.command }) || (result.code !== undefined && !id(result.code)) || (result.message !== undefined && typeof result.message !== 'string') || (result.status === 'pending' && result.command !== 'rebuy'))
      throw new Error('Invalid command result');
    commandIds.add(key);
    if (result.status === 'pending' && !ledger.participants.some(p => p.playerId === c.playerId && p.pendingRebuyRequestId === result.requestId))
      throw new Error('Missing pending rebuy');
  }
  for (const [p, deadline] of Object.entries(raw.reconnectDeadlines))
    if (!players.has(p) || !integer(deadline) || ledger.participants.find(row => row.playerId === p)?.seatStatus !== 'seated')
      throw new Error('Invalid reconnect deadline');
  if (ledger.participants.some(p => p.pendingRebuyRequestId !== null && !(raw.commands as StoredCommand[]).some(c => {
    const command = c as StoredCommand;
    return command.playerId === p.playerId && command.result.requestId === p.pendingRebuyRequestId && command.result.command === 'rebuy' && command.result.status === 'pending';
  })))
    throw new Error('Missing pending command receipt');
  if (raw.lifecycle === 'ended' && raw.settlement === null)
    throw new Error('Missing final settlement');
  if (raw.lifecycle !== 'ended' && raw.settlement !== null)
    throw new Error('Premature final settlement');
  // Runtime DTO validation also guards the persisted public projections.
  if (raw.recoveryNotice !== null)
    validateNotice(raw.recoveryNotice, raw.sessionId as string, raw.checkpointVersion as number, raw.handAttemptId as number);
  if (raw.settlement !== null) {
    const s = raw.settlement;
    if (!isObject(s))
      throw new Error('Invalid settlement');
    exact(s, ['sessionId', 'shareId', 'endedAt', 'expiresAt', 'reason', 'recoveryNotice', 'rows']);
    if (s.sessionId !== raw.sessionId || typeof s.shareId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(s.shareId) || !integer(s.endedAt) || !integer(s.expiresAt) || s.expiresAt !== (s.endedAt as number) + 30 * 86400000 || !Array.isArray(s.rows) || !['host-ended', 'last-player-left', 'all-offline-timeout'].includes(s.reason as string) || s.reason !== raw.endReason || raw.inFlightHandId !== null)
      throw new Error('Invalid settlement');
    if (s.recoveryNotice !== null)
      validateNotice(s.recoveryNotice, raw.sessionId as string, raw.checkpointVersion as number, raw.handAttemptId as number);
    if (JSON.stringify(s.recoveryNotice) !== JSON.stringify(raw.recoveryNotice))
      throw new Error('Settlement recovery mismatch');
    const rowIds = new Set<string>();
    for (const row of s.rows) {
      if (!isObject(row))
        throw new Error('Invalid settlement row');
      exact(row, ['playerId', 'nickname', 'rebuyCount', 'totalBuyIn', 'finalChips', 'net']);
      const p = ledger.participants.find(p => p.playerId === row.playerId);
      if (!p || rowIds.has(p.playerId) || row.nickname !== p.nickname || !integer(row.rebuyCount) || row.rebuyCount !== p.rebuyCount || !integer(row.totalBuyIn) || row.totalBuyIn !== p.totalBuyIn || !integer(row.finalChips) || row.finalChips !== p.stack + p.releasedChips || !Number.isSafeInteger(row.net) || row.net !== row.finalChips - row.totalBuyIn)
        throw new Error('Invalid settlement row');
      rowIds.add(p.playerId);
    }
    if (s.rows.length !== players.size || s.rows.reduce((sum, p) => sum + (p as {
      net: number;
    }).net, 0) !== 0)
      throw new Error('Invalid final conservation');
  }
  // Reading v1 is side-effect free: keep identity/revision/ledger intact. The next
  // ordinary transaction atomically persists the upgraded representation.
  const migrated = cloneRecord(raw as unknown as MatchRecord);
  migrated.schemaVersion = 2;
  migrated.blinds = raw.schemaVersion === 1 ? { ...DEFAULT_BLINDS } : { ...(raw.blinds as unknown as BlindConfig) };
  return migrated;
}
function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function id(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function integer(v: unknown, min = 0): v is number {
  return Number.isSafeInteger(v) && (v as number) >= min;
}
function nullableInteger(v: unknown, min = 0): boolean {
  return v === null || integer(v, min);
}
function exact(v: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(k => !keys.includes(k)))
    throw new Error('Unexpected persisted field');
}
function allowed(v: Record<string, unknown>, keys: string[], required: string[]): void {
  if (Object.keys(v).some(k => !keys.includes(k)) || required.some(k => !(k in v)))
    throw new Error('Unexpected persisted field');
}
function validateNotice(v: unknown, sessionId: string, checkpoint: number, attempt: number): void {
  if (!isObject(v))
    throw new Error('Invalid recovery notice');
  exact(v, ['sessionId', 'tableEpoch', 'checkpointVersion', 'rolledBackHandId', 'reason']);
  if (v.sessionId !== sessionId || !id(v.tableEpoch) || !integer(v.checkpointVersion) || v.checkpointVersion > checkpoint || !integer(v.rolledBackHandId, 1) || v.rolledBackHandId > attempt || !['server-restart', 'all-offline-timeout'].includes(v.reason as string))
    throw new Error('Invalid recovery notice');
}
