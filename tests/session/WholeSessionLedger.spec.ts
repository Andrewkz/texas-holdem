import { expect, it } from 'vitest';
import { SessionLedger } from '../../server/src/session/SessionLedger';
import { hashToken, validateMatchRecord, type MatchRecord, type StoredCommand } from '../../server/src/session/MatchRecord';
import { MemoryMatchStore } from '../../server/src/session/MemoryMatchStore';
import { RoomManager } from '../../server/src/RoomManager';
import { connect } from '../net/fakes';

it('finalizes a restored multi-rebuy, departure and rejoin history against independent hand-calculated ownership', () => {
  // Deterministic completed-hand inputs exercise the ledger separately from engine payout calculations.
  // Engine main/side pots have their own fixed-deck tests; no synthetic bank participant is added here.
  const sessionId = 'whole-match-ledger';
  const ledger = SessionLedger.create(sessionId);
  for (let i = 0; i < 3; i++) ledger.addParticipant(`p${i + 1}`, ['A', 'B', 'C'][i], `join-${i + 1}`);
  ledger.settleHand(1, { p1: 0, p2: 10000, p3: 5000 });
  ledger.queueRebuy('p1', 'rebuy-one'); ledger.applyPendingRebuys(2);
  ledger.settleHand(2, { p1: 0, p2: 15000, p3: 5000 });
  ledger.queueRebuy('p1', 'rebuy-two'); ledger.applyPendingRebuys(3);
  ledger.settleHand(3, { p1: 4000, p2: 14000, p3: 7000 });
  ledger.requestDeparture('p1', null); ledger.rejoin('p1');
  ledger.settleHand(4, { p1: 7000, p2: 11000, p3: 7000 });
  ledger.requestDeparture('p2', null);
  const commands: StoredCommand[] = ['rebuy-one', 'rebuy-two'].map(requestId => ({ playerId: 'p1', fingerprint: JSON.stringify({ command: 'rebuy' }), result: { sessionId, requestId, command: 'rebuy', status: 'committed' } }));
  const proofs = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
  const record: MatchRecord = validateMatchRecord({
    schemaVersion: 1, sessionId, revision: 1, roomCode: 'AB23', createdAt: Date.now(), ledger: ledger.toJSON(),
    credentials: proofs.map((token, i) => ({ playerId: `p${i + 1}`, tokenHash: hashToken(token) })),
    admissions: proofs.map((token, i) => ({ requestId: `join-${i + 1}`, type: i === 0 ? 'createRoom' : 'joinRoom', nickname: ['A', 'B', 'C'][i], tokenHash: hashToken(token), playerId: `p${i + 1}` })),
    commands, seatOrder: ['p1', 'p3'], hostId: 'p1', nextPlayerNumber: 4, lastDealerPlayerId: 'p1', lastDealerSeatIndex: 0,
    handAttemptId: 4, checkpointVersion: 4, inFlightHandId: null, lifecycle: 'active', endReason: null,
    reconnectDeadlines: {}, allOfflineDeadline: null, recoveryNotice: null, settlement: null,
  });
  const manager = new RoomManager({ store: new MemoryMatchStore([record]) });
  try {
    const host = connect(manager);
    manager.handleMessage(host, { type: 'reconnect', sessionId, token: proofs[0] });
    expect(host.last('joined')?.playerId).toBe('p1');
    const end = { type: 'requestEnd' as const, sessionId, requestId: 'end-whole-match' };
    manager.handleMessage(host, end);
    const final = host.last('sessionEnded')!.settlement;
    // Independent oracle: A invested15k, withdrew/returned4k, finishes7k => -8k.
    // B invested5k, departed11k => +6k. C invested5k, finishes7k => +2k.
    expect(final.rows).toEqual([
      { playerId: 'p1', nickname: 'A', rebuyCount: 2, totalBuyIn: 15000, finalChips: 7000, net: -8000 },
      { playerId: 'p2', nickname: 'B', rebuyCount: 0, totalBuyIn: 5000, finalChips: 11000, net: 6000 },
      { playerId: 'p3', nickname: 'C', rebuyCount: 0, totalBuyIn: 5000, finalChips: 7000, net: 2000 },
    ]);
    expect(final.rows.map(row => row.net)).toEqual([-8000, 6000, 2000]);
    expect(final.rows.reduce((sum, row) => sum + row.net, 0)).toBe(0);
    expect(final.rows.reduce((sum, row) => sum + row.finalChips, 0)).toBe(25000);
    const fixed = structuredClone(final);
    manager.handleMessage(host, end);
    expect(manager.records()[0].settlement).toEqual(fixed);
    expect(manager.getSettlement(final.shareId)).toEqual({ status: 200, settlement: fixed });
    expect(() => validateMatchRecord(manager.records()[0])).not.toThrow();
  } finally { manager.dispose(); }
});
