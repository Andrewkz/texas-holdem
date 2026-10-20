import { Card, EngineSnapshot, PlayerAction } from '../core/types';
import { BlindConfig, normalizeBlinds, validateBlinds } from '../core/Blinds';
import { SessionMeta, LedgerSnapshot, CommandResult, RecoveryNotice, FinalSettlement } from './SessionTypes';
export * from './SessionTypes';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;
export const MAX_SEATS = 6;
export const STARTING_STACK = 5000;
export const ACTION_TIMEOUT_MS = 30_000;
export const RECONNECT_WINDOW_MS = 180_000;
export const PROTOCOL_VERSION = 4;
export const BETWEEN_HANDS_MS = 5_000;
export const DEFAULT_SERVER_URL = 'ws://localhost:2567';
export const ONLINE_SESSION_STORAGE_KEY = 'texas-holdem.online.v1';

export interface RoomSeat {
  playerId: string;
  nickname: string;
  stack: number;
  connected: boolean;
}

export interface RoomStateMessage {
  code: string;
  session: SessionMeta;
  phase: 'lobby' | 'playing';
  hostId: string;
  seats: RoomSeat[];
  /** Fixed for this session. Authoritative servers always send this field. */
  blinds?: BlindConfig;
}

export type TableParticipation = 'playing-hand' | 'waiting-next-hand';

/** One authoritative action window; serverNow lets clients avoid local clock skew. */
export interface TurnTimer {
  playerId: string;
  deadlineAt: number;
  serverNow: number;
  durationMs: number;
}

export type ErrorCode =
  | 'protocol-mismatch'
  | 'bad-message'
  | 'room-not-found'
  | 'room-full'
  | 'nickname-taken'
  | 'not-host'
  | 'not-in-room'
  | 'game-not-started'
  | 'not-your-turn'
  | 'illegal-action'
  | 'session-taken-over' | 'session-ended' | 'pending-equity' | 'invalid-proof' | 'request-conflict' | 'storage-failed' | 'stale-action' | 'rebuy-not-allowed' | 'command-not-found';

export type ClientMessage =
  | { type: 'hello'; protocolVersion: number }
  | { type: 'lookupRoom'; roomCode: string }
  | { type: 'createRoom'; nickname: string; requestId: string; token: string; blinds?: BlindConfig }
  | { type: 'joinRoom'; roomCode: string; sessionId: string; nickname: string; requestId: string; token: string }
  | { type: 'reconnect'; sessionId: string; token: string }
  | { type: 'rejoin'; sessionId: string; token: string; requestId: string }
  | { type: 'leaveRoom' | 'rebuy' | 'requestEnd'; sessionId: string; requestId: string }
  | {type:'commandStatus';sessionId:string;requestId:string;token?:string}
  | { type: 'startGame'; sessionId: string }
  | { type: 'action'; sessionId: string; tableEpoch: string; handId: number; action: PlayerAction };

type TableScope = { sessionId: string; tableEpoch: string };
export type ServerMessage =
  | { type: 'hello'; protocolVersion: number }
  | { type: 'roomLookup'; roomCode: string; sessionId: string }
  | { type: 'joined'; roomCode: string; sessionId: string; token: string; playerId: string; room: RoomStateMessage; requestId?: string }
  | { type: 'leftIdentity'; sessionId: string; playerId: string }
  | { type: 'roomState'; room: RoomStateMessage }
  | { type: 'ledgerSync'; ledger: LedgerSnapshot }
  | { type: 'commandResult'; result: CommandResult }
  | { type: 'recoveryNotice'; notice: RecoveryNotice }
  | { type: 'sessionEnded'; settlement: FinalSettlement }
  | (TableScope & { type: 'handStart'; handId: number; dealerPlayerId: string; participantIds: string[] })
  | (TableScope & { type: 'yourHand'; handId: number; cards: Card[] })
  | (TableScope & { type: 'stateSync'; snapshot: EngineSnapshot; participation: TableParticipation; turnTimer?: TurnTimer | null })
  | (TableScope & { type: 'actionTaken'; handId: number; playerId: string; action: PlayerAction; amount: number })
  | (TableScope & { type: 'showdown'; handId: number; reveals: { playerId: string; cards: Card[]; handName: string }[] })
  | (TableScope & { type: 'handResult'; handId: number; payouts: { playerId: string; amount: number; handName: string }[] })
  | { type: 'error'; code: ErrorCode; message: string };

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isRecord(raw)) return null;
  const nickname = parseNickname(raw.nickname);
  const admission = isId(raw.requestId) && isToken(raw.token);
  const management = isId(raw.sessionId) && isId(raw.requestId);
  switch (raw.type) {
    case 'hello': return isChips(raw.protocolVersion) ? {type:'hello',protocolVersion:raw.protocolVersion} : null;
    case 'lookupRoom': return isId(raw.roomCode) ? {type:'lookupRoom',roomCode:raw.roomCode} : null;
    case 'createRoom': return nickname && admission && (raw.blinds === undefined || validateBlinds(raw.blinds))
      ? {type:'createRoom',nickname,requestId:raw.requestId as string,token:raw.token as string,
        ...(raw.blinds === undefined ? {} : { blinds: normalizeBlinds(raw.blinds) })} : null;
    case 'joinRoom': return nickname && admission && !('blinds' in raw) && isId(raw.roomCode) && isId(raw.sessionId)
      ? {type:'joinRoom',nickname,requestId:raw.requestId as string,token:raw.token as string,roomCode:raw.roomCode,sessionId:raw.sessionId} : null;
    case 'reconnect': return isId(raw.sessionId) && isId(raw.token) ? {type:'reconnect',sessionId:raw.sessionId,token:raw.token} : null;
    case 'rejoin': return management && isId(raw.token) ? {type:'rejoin',sessionId:raw.sessionId as string,requestId:raw.requestId as string,token:raw.token} : null;
    case 'commandStatus':
      return management && (raw.token===undefined || isId(raw.token)) ? {type:'commandStatus',sessionId:raw.sessionId as string,requestId:raw.requestId as string,...(raw.token!==undefined?{token:raw.token as string}:{})} : null;
    case 'leaveRoom': case 'rebuy': case 'requestEnd':
      return management && !('amount' in raw) ? {type:raw.type,sessionId:raw.sessionId as string,requestId:raw.requestId as string} : null;
    case 'startGame': return isId(raw.sessionId) ? {type:'startGame',sessionId:raw.sessionId} : null;
    case 'action': {
      const action = parsePlayerAction(raw.action);
      return action && isScope(raw) && isHandId(raw.handId) ? {type:'action',sessionId:raw.sessionId,tableEpoch:raw.tableEpoch,handId:raw.handId,action} : null;
    }
    default: return null;
  }
}

function parseNickname(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const nickname = raw.trim();
  return nickname.length >= 1 && nickname.length <= 12 ? nickname : null;
}

function parsePlayerAction(raw: unknown): PlayerAction | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const action = raw as Record<string, unknown>;

  switch (action.type) {
    case 'fold':
    case 'check':
    case 'all-in':
      return { type: action.type };
    case 'call':
      return isChips(action.amount) && action.amount > 0
        ? { type: 'call', amount: action.amount }
        : null;
    case 'raise':
      return isChips(action.to) && action.to > 0
        ? { type: 'raise', to: action.to }
        : null;
    default:
      return null;
  }
}


/** Validate wire data before it can enter the session or presentation layer. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (!isRecord(raw)) return null;
  let valid = false;
  switch (raw.type) {
    case 'hello':
      valid = Number.isInteger(raw.protocolVersion) && (raw.protocolVersion as number) >= 0;
      break;
    case 'joined':
      valid = isId(raw.roomCode) && isId(raw.sessionId) && isId(raw.token) && isId(raw.playerId) && isRoom(raw.room) && raw.room.session.sessionId === raw.sessionId;
      break;
    case 'roomLookup': valid = isId(raw.roomCode) && isId(raw.sessionId); break;
    case 'leftIdentity': valid = isId(raw.sessionId) && isId(raw.playerId); break;
    case 'ledgerSync': valid = isLedger(raw.ledger); break;
    case 'commandResult': valid = isCommandResult(raw.result); break;
    case 'recoveryNotice': valid = isRecovery(raw.notice); break;
    case 'sessionEnded': valid = isSettlement(raw.settlement);
      break;
    case 'roomState': valid = isRoom(raw.room); break;
    case 'handStart':
      valid = isScope(raw) && isHandId(raw.handId) && isId(raw.dealerPlayerId) && Array.isArray(raw.participantIds)
        && raw.participantIds.length >= 2 && raw.participantIds.length <= MAX_SEATS
        && raw.participantIds.every(isId) && new Set(raw.participantIds).size === raw.participantIds.length
        && raw.participantIds.indexOf(raw.dealerPlayerId) >= 0;
      break;
    case 'yourHand': valid = isScope(raw) && isHandId(raw.handId) && isCards(raw.cards, 2) && raw.cards.length === 2; break;
    case 'stateSync':
      valid = isScope(raw) && (raw.participation === 'playing-hand' || raw.participation === 'waiting-next-hand') && isSnapshot(raw.snapshot)
        && (raw.participation !== 'waiting-next-hand' || raw.snapshot.legalActions.length === 0)
        && (raw.turnTimer === undefined || raw.turnTimer === null || isTurnTimer(raw.turnTimer, raw.snapshot));
      break;
    case 'actionTaken': valid = isScope(raw) && isHandId(raw.handId) && isId(raw.playerId) && parsePlayerAction(raw.action) !== null && isChips(raw.amount); break;
    case 'showdown':
      valid = isScope(raw) && isHandId(raw.handId) && Array.isArray(raw.reveals) && raw.reveals.every(reveal =>
        isRecord(reveal) && isId(reveal.playerId) && isCards(reveal.cards, 2) && reveal.cards.length === 2 && isId(reveal.handName));
      break;
    case 'handResult':
      valid = isScope(raw) && isHandId(raw.handId) && Array.isArray(raw.payouts) && raw.payouts.every(payout =>
        isRecord(payout) && isId(payout.playerId) && isChips(payout.amount) && typeof payout.handName === 'string');
      break;
    case 'error':
      valid = typeof raw.message === 'string' && typeof raw.code === 'string' && [
        'protocol-mismatch', 'bad-message', 'room-not-found', 'room-full', 'nickname-taken', 'not-host',
        'not-in-room', 'game-not-started', 'not-your-turn', 'illegal-action', 'session-taken-over', 'session-ended', 'pending-equity', 'invalid-proof', 'request-conflict', 'storage-failed', 'stale-action', 'rebuy-not-allowed', 'command-not-found',
      ].indexOf(raw.code) >= 0;
      break;
  }
  return valid ? raw as unknown as ServerMessage : null;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw);
}
function isId(raw: unknown): raw is string { return typeof raw === 'string' && raw.length > 0; }
function isChips(raw: unknown): raw is number { return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0; }
function isHandId(raw: unknown): raw is number { return Number.isSafeInteger(raw) && (raw as number) > 0; }
function isTurnTimer(raw: unknown, snapshot: EngineSnapshot): raw is TurnTimer {
  return isRecord(raw) && snapshot.street !== 'settled' && isId(raw.playerId)
    && raw.playerId === snapshot.actingPlayerId && isChips(raw.deadlineAt)
    && isChips(raw.serverNow) && isHandId(raw.durationMs);
}
function isCards(raw: unknown, max: number): raw is Card[] {
  return Array.isArray(raw) && raw.length <= max && raw.every(card => isRecord(card)
    && ['S', 'H', 'D', 'C'].indexOf(card.suit as string) >= 0
    && Number.isInteger(card.rank) && (card.rank as number) >= 2 && (card.rank as number) <= 14);
}
function isRoom(raw: unknown): raw is RoomStateMessage {
  return isRecord(raw) && (raw.blinds === undefined || validateBlinds(raw.blinds)) && isId(raw.code) && isSession(raw.session) && (raw.phase === 'lobby' || raw.phase === 'playing')
    && typeof raw.hostId === 'string' && Array.isArray(raw.seats) && raw.seats.length <= MAX_SEATS
    && raw.seats.every(seat => isRecord(seat) && isId(seat.playerId) && isId(seat.nickname)
      && isChips(seat.stack) && typeof seat.connected === 'boolean');
}
function isSnapshot(raw: unknown): raw is EngineSnapshot {
  return isRecord(raw) && isHandId(raw.handId) && (raw.blinds === undefined || validateBlinds(raw.blinds))
    && ['preflop', 'flop', 'turn', 'river', 'showdown', 'settled'].indexOf(raw.street as string) >= 0
    && (raw.actingPlayerId === null || isId(raw.actingPlayerId))
    && (raw.dealerPlayerId === null || isId(raw.dealerPlayerId)) && isChips(raw.pot)
    && isCards(raw.communityCards, 5) && Array.isArray(raw.legalActions)
    && raw.legalActions.every(action => parsePlayerAction(action) !== null)
    && Array.isArray(raw.players) && raw.players.length >= 1 && raw.players.length <= MAX_SEATS
    && raw.players.every(player => isRecord(player) && isId(player.id) && isId(player.name)
      && isChips(player.stack) && typeof player.folded === 'boolean' && typeof player.allIn === 'boolean'
      && isChips(player.streetContribution) && isChips(player.totalContribution));
}

function isToken(raw: unknown): raw is string { return typeof raw === 'string' && /^[a-f0-9]{64}$/.test(raw); }
function isScope(raw: Record<string, unknown>): raw is Record<string, unknown> & TableScope { return isId(raw.sessionId) && isId(raw.tableEpoch); }
function isSession(raw: unknown): raw is SessionMeta {
  return isRecord(raw) && isScope(raw) && ['active','ending-after-hand','all-offline-wait','ended'].indexOf(raw.lifecycle as string)>=0
    && isChips(raw.checkpointVersion) && (raw.allOfflineDeadline === null || isChips(raw.allOfflineDeadline));
}
function isLedger(raw: unknown): raw is LedgerSnapshot {
  return isRecord(raw) && isId(raw.sessionId) && isChips(raw.committedHandId) && Array.isArray(raw.rows)
    && raw.rows.every(row => isRecord(row) && isId(row.playerId) && isId(row.nickname)
      && ['seated','leaving-hand','left'].indexOf(row.seatStatus as string)>=0
      && isChips(row.totalBuyIn) && isChips(row.rebuyCount) && isChips(row.stack) && isChips(row.releasedChips)
      && (row.pendingDepartureHandId===null || isHandId(row.pendingDepartureHandId))
      && (row.pendingRebuyRequestId===null || isId(row.pendingRebuyRequestId)))
    && new Set(raw.rows.map(row=>row.playerId)).size===raw.rows.length;
}
function isCommandResult(raw: unknown): raw is CommandResult {
  return isRecord(raw) && isId(raw.sessionId) && isId(raw.requestId)
    && ['rebuy','requestEnd','leaveRoom','rejoin'].indexOf(raw.command as string)>=0
    && ['pending','committed','rejected'].indexOf(raw.status as string)>=0
    && (raw.code===undefined || isId(raw.code)) && (raw.message===undefined || typeof raw.message==='string');
}
function isRecovery(raw: unknown): raw is RecoveryNotice {
  return isRecord(raw) && isScope(raw) && isChips(raw.checkpointVersion) && isHandId(raw.rolledBackHandId)
    && ['server-restart','all-offline-timeout'].indexOf(raw.reason as string)>=0;
}
export function isFinalSettlement(raw: unknown): raw is FinalSettlement { return isSettlement(raw); }
function isSettlement(raw: unknown): raw is FinalSettlement {
  if (!isRecord(raw) || !isId(raw.sessionId) || !isId(raw.shareId) || !isChips(raw.endedAt) || !isChips(raw.expiresAt)
    || raw.expiresAt !== raw.endedAt+30*86400000 || ['host-ended','last-player-left','all-offline-timeout'].indexOf(raw.reason as string)<0
    || !(raw.recoveryNotice===null || isRecovery(raw.recoveryNotice)) || !Array.isArray(raw.rows)) return false;
  return raw.rows.every(row=>isRecord(row) && isId(row.playerId) && isId(row.nickname) && isChips(row.rebuyCount)
    && isChips(row.totalBuyIn) && isChips(row.finalChips) && Number.isSafeInteger(row.net)
    && row.net === row.finalChips-row.totalBuyIn)
    && raw.rows.reduce((sum,row)=>sum+row.net,0)===0 && new Set(raw.rows.map(row=>row.playerId)).size===raw.rows.length;
}
