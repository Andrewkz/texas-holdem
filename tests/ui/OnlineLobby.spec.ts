import { describe, expect, it } from 'vitest';
import { countLobbyStartPlayers } from '../../assets/scripts/ui/OnlineLobby';
import { LedgerSnapshot, RoomStateMessage } from '../../assets/scripts/net/protocol';

const room: RoomStateMessage = {
  code: 'ABCD', phase: 'lobby', hostId: 'p1',
  session: { sessionId: 's1', tableEpoch: 'e1', lifecycle: 'active', checkpointVersion: 1, allOfflineDeadline: null },
  seats: [{ playerId: 'p1', nickname: '甲', stack: 5000, connected: true }, { playerId: 'p2', nickname: '乙', stack: 0, connected: true }],
};
const ledger: LedgerSnapshot = { sessionId: 's1', committedHandId: 1, rows: [{ playerId: 'p2', nickname: '乙', stack: 0, releasedChips: 0, rebuyCount: 0, totalBuyIn: 5000, seatStatus: 'seated', pendingDepartureHandId: null, pendingRebuyRequestId: 'queued' }] };

describe('lobby start eligibility', () => {
  it('counts an online settled-zero seat whose next-hand rebuy is queued', () => {
    expect(countLobbyStartPlayers(room, ledger)).toBe(2);
    expect(room.seats[1].stack).toBe(0); // Displaying eligibility never credits temporary chips.
  });
  it('does not count a plain zero balance, pending departure, or offline seat', () => {
    expect(countLobbyStartPlayers(room, null)).toBe(1);
    expect(countLobbyStartPlayers(room, { ...ledger, rows: [{ ...ledger.rows[0], pendingDepartureHandId: 2, seatStatus: 'leaving-hand' }] })).toBe(1);
    expect(countLobbyStartPlayers({ ...room, seats: [room.seats[0], { ...room.seats[1], connected: false }] }, ledger)).toBe(1);
  });
  it('ignores a stale ledger from another session even when player IDs match', () => {
    expect(countLobbyStartPlayers(room, { ...ledger, sessionId: 'old-session' })).toBe(1);
  });
});
