import type { LedgerSnapshot, RoomStateMessage } from '../net/protocol';

/** Eligibility is separate from the displayed stack: queued chips apply only at the next hand. */
export function countLobbyStartPlayers(room: RoomStateMessage, ledger: LedgerSnapshot | null): number {
  const rows = ledger?.sessionId === room.session.sessionId ? ledger.rows : [];
  return room.seats.filter(seat => {
    if (!seat.connected) return false;
    const row = rows.find(candidate => candidate.playerId === seat.playerId);
    if (!row) return seat.stack > 0;
    return row.seatStatus === 'seated' && row.pendingDepartureHandId === null
      && (row.stack > 0 || row.pendingRebuyRequestId !== null);
  }).length;
}
