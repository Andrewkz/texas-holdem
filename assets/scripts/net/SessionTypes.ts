/** Public DTOs only. Never put credentials, private cards, or persistence records here. */
export type SessionLifecycle = 'active' | 'ending-after-hand' | 'all-offline-wait' | 'ended';
export type SeatStatus = 'seated' | 'leaving-hand' | 'left';
export type EndReason = 'host-ended' | 'last-player-left' | 'all-offline-timeout';
export interface SessionMeta {
  sessionId: string;
  tableEpoch: string;
  lifecycle: SessionLifecycle;
  checkpointVersion: number;
  allOfflineDeadline: number | null;
}
export interface LedgerRow {
  playerId: string;
  nickname: string;
  seatStatus: SeatStatus;
  totalBuyIn: number;
  rebuyCount: number;
  stack: number;
  releasedChips: number;
  pendingDepartureHandId: number | null;
  pendingRebuyRequestId: string | null;
}
export interface LedgerSnapshot {
  sessionId: string;
  committedHandId: number;
  rows: LedgerRow[];
}
export type CommandType = 'rebuy' | 'requestEnd' | 'leaveRoom' | 'rejoin';
export interface CommandResult {
  sessionId: string;
  requestId: string;
  command: CommandType;
  status: 'pending' | 'committed' | 'rejected';
  code?: string;
  message?: string;
}
export interface RecoveryNotice {
  sessionId: string;
  tableEpoch: string;
  checkpointVersion: number;
  rolledBackHandId: number;
  reason: 'server-restart' | 'all-offline-timeout';
}
export interface FinalSettlementRow {
  playerId: string;
  nickname: string;
  rebuyCount: number;
  totalBuyIn: number;
  finalChips: number;
  net: number;
}
/** Exact public whitelist returned by HTTP and sessionEnded. */
export interface FinalSettlement {
  sessionId: string;
  shareId: string;
  endedAt: number;
  expiresAt: number;
  reason: EndReason;
  recoveryNotice: RecoveryNotice | null;
  rows: FinalSettlementRow[];
}
