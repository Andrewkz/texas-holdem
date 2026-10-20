import { describe, expect, it } from 'vitest';
import { SessionLedger } from '../../server/src/session/SessionLedger';

function pair() {
  const ledger = SessionLedger.create('session');
  ledger.addParticipant('a', 'Alice', 'join-a');
  ledger.addParticipant('b', 'Bob', 'join-b');
  return ledger;
}
function expectCode(fn: () => unknown, code: string) { expect(fn).toThrowError(expect.objectContaining({ code })); }

describe('SessionLedger', () => {
  it('issues the initial chips once and never exposes mutable participant or snapshot state', () => {
    const ledger = pair();
    const person = ledger.addParticipant('a', 'Alice', 'retry-a');
    person.stack = 999;
    const snapshot = ledger.toJSON();
    snapshot.participants[0].totalBuyIn = 999;
    snapshot.entries[0].amount = 0;
    const restored = new SessionLedger(ledger.toJSON());
    expect(restored.toJSON().participants[0]).toMatchObject({ stack: 5000, totalBuyIn: 5000 });
    expect(restored.toJSON().entries.filter(e => e.type === 'initial')).toHaveLength(2);
    expectCode(() => ledger.addParticipant('a', 'Other', 'join-a'), 'participant-conflict');
    expectCode(() => ledger.addParticipant('c', 'Carol', 'join-a'), 'request-conflict');
  });

  it('queues fixed rebuys once and only applies them at the next hand boundary', () => {
    const ledger = pair();
    expectCode(() => ledger.queueRebuy('a', 'too-soon'), 'rebuy-ineligible');
    ledger.settleHand(1, { a: 0, b: 10000 });
    expect(ledger.queueRebuy('a', 'r1')).toBe(true);
    expect(ledger.queueRebuy('a', 'r1')).toBe(false);
    expectCode(() => ledger.queueRebuy('a', 'r2'), 'rebuy-pending');
    expect(ledger.toJSON().participants[0]).toMatchObject({ stack: 0, totalBuyIn: 5000, rebuyCount: 0 });
    expectCode(() => ledger.applyPendingRebuys(1), 'invalid-hand');
    expect(ledger.applyPendingRebuys(2)).toEqual(['r1']);
    expect(ledger.applyPendingRebuys(2)).toEqual([]);
    expect(ledger.toJSON().participants[0]).toMatchObject({ stack: 5000, totalBuyIn: 10000, rebuyCount: 1 });
    ledger.settleHand(2, { a: 0, b: 15000 });
    expect(ledger.queueRebuy('a', 'r1')).toBe(false);
    expect(ledger.queueRebuy('a', 'r2')).toBe(true);
    ledger.applyPendingRebuys(3);
    expect(ledger.toJSON().participants[0]).toMatchObject({ stack: 5000, totalBuyIn: 15000, rebuyCount: 2 });
    ledger.assertConserved();
  });

  it('cancels queued rebuys without issuing chips on departure or explicit cancellation', () => {
    const ledger = pair();
    ledger.settleHand(1, { a: 0, b: 10000 });
    ledger.queueRebuy('a', 'r1');
    expect(ledger.cancelPendingRebuys()).toEqual(['r1']);
    expect(ledger.cancelPendingRebuys()).toEqual([]);
    ledger.queueRebuy('a', 'r2');
    ledger.requestDeparture('a', null);
    expect(ledger.applyPendingRebuys(2)).toEqual([]);
    expect(ledger.toJSON().participants[0]).toMatchObject({ seatStatus: 'left', totalBuyIn: 5000, pendingRebuyRequestId: null });
    expectCode(() => ledger.queueRebuy('a', 'r3'), 'rebuy-ineligible');
  });

  it('retains pending hand equity then transfers the settled ownership exactly once on repeated departure and rejoin', () => {
    const ledger = pair();
    ledger.requestDeparture('a', 1);
    expectCode(() => ledger.rejoin('a'), 'pending-equity');
    expect(ledger.toJSON().participants[0]).toMatchObject({ seatStatus: 'leaving-hand', stack: 5000, releasedChips: 0 });
    ledger.settleHand(1, { a: 7000, b: 3000 });
    expect(ledger.toJSON().participants[0]).toMatchObject({ seatStatus: 'left', stack: 0, releasedChips: 7000 });
    ledger.requestDeparture('a', null);
    ledger.rejoin('a'); ledger.rejoin('a');
    expect(ledger.toJSON().participants[0]).toMatchObject({ stack: 7000, releasedChips: 0, totalBuyIn: 5000 });
    ledger.requestDeparture('a', null); ledger.rejoin('a');
    const rows = ledger.toJSON().participants;
    expect(rows.reduce((sum,p) => sum + p.stack + p.releasedChips - p.totalBuyIn, 0)).toBe(0);
    expect(ledger.toJSON().entries.filter(e => e.type === 'rejoin')).toHaveLength(2);
    ledger.assertConserved();
  });

  it('deduplicates settled hands by exact payload, accepts skipped attempt IDs and rejects inconsistent results atomically', () => {
    const ledger = pair();
    ledger.settleHand(3, { a: 8000, b: 2000 });
    expect(ledger.settleHand(3, { b: 2000, a: 8000 })).toBe(false);
    const before = ledger.toJSON();
    expectCode(() => ledger.settleHand(3, { a: 7000, b: 3000 }), 'hand-conflict');
    expectCode(() => ledger.settleHand(2, { a: 8000, b: 2000 }), 'invalid-hand');
    expectCode(() => ledger.settleHand(4, { a: 8001, b: 2000 }), 'not-conserved');
    expectCode(() => ledger.settleHand(4, { a: -1, b: 10001 }), 'invalid-ledger');
    expectCode(() => ledger.settleHand(4, { a: Number.MAX_SAFE_INTEGER + 1 }), 'invalid-ledger');
    expect(ledger.toJSON()).toEqual(before);
    expect(ledger.toJSON().entries.filter(e => e.type === 'hand-settlement').map(e => e.amount)).toEqual([3000, -3000]);
  });

  it('preserves newcomers outside a hand payload and all historical departed rows', () => {
    const ledger = pair();
    ledger.addParticipant('c', 'Carol', 'join-c');
    ledger.settleHand(1, { a: 6000, b: 4000 });
    ledger.requestDeparture('a', null);
    for (let i=0;i<7;i++) { ledger.addParticipant(`extra${i}`, 'Guest', `guest${i}`); ledger.requestDeparture(`extra${i}`, null); }
    expect(ledger.toJSON().participants).toHaveLength(10);
    expect(ledger.toJSON().participants[2].stack).toBe(5000);
    ledger.assertConserved();
  });

  it('rejects corrupt restored balances, duplicate identities and unsafe signed non-settlement entries', () => {
    const data = pair().toJSON();
    expect(() => new SessionLedger({...data, participants: [...data.participants, data.participants[0]]})).toThrow();
    const negative = structuredClone(data); negative.entries[0].amount = -5000;
    expectCode(() => new SessionLedger(negative), 'invalid-ledger');
    const unsafe = structuredClone(data); unsafe.participants[0].stack = 1.5;
    expectCode(() => new SessionLedger(unsafe), 'invalid-ledger');
    const unbalanced = structuredClone(data); unbalanced.participants[0].stack++;
    expectCode(() => new SessionLedger(unbalanced), 'not-conserved');
  });
});

describe('rolled-back hand ownership', () => {
  it('resolves only that hand departure at the last committed boundary without inventing a settlement', () => {
    const ledger = pair();
    ledger.settleHand(1, { a: 0, b: 10000 });
    ledger.queueRebuy('a', 'keep-rebuy');
    ledger.requestDeparture('b', 4);
    ledger.addParticipant('c', 'Carol', 'join-c');
    expect(ledger.resolveRolledBackHand(4)).toEqual(['b']);
    expect(ledger.resolveRolledBackHand(4)).toEqual([]);
    expect(ledger.toJSON().committedHandId).toBe(1);
    expect(ledger.toJSON().appliedHands).toHaveLength(1);
    expect(ledger.toJSON().participants[1]).toMatchObject({ stack: 0, releasedChips: 10000, seatStatus: 'left', pendingDepartureHandId: null });
    expect(ledger.toJSON().participants[0].pendingRebuyRequestId).toBe('keep-rebuy');
    expect(ledger.toJSON().participants[2].stack).toBe(5000);
    expect(ledger.toJSON().entries.filter(e => e.type === 'depart')).toHaveLength(1);
    ledger.assertConserved();
    expectCode(() => ledger.resolveRolledBackHand(1), 'invalid-hand');
  });
});

describe('ledger restored history and admission conflicts', () => {
  it('rejects an admission request already owned by a different participant even for an existing player ID', () => {
    const ledger=pair();
    expectCode(()=>ledger.addParticipant('a','Alice','join-b'),'request-conflict');
  });
  it('rejects mismatched settlement history and participant ownership transfers in a restored record', () => {
    const ledger=pair();ledger.settleHand(1,{a:7000,b:3000});ledger.requestDeparture('a',null);
    const history=ledger.toJSON();history.appliedHands[0].stacks.a=8000;
    expectCode(()=>new SessionLedger(history),'invalid-ledger');
    const transfer=ledger.toJSON();transfer.entries.find(e=>e.type==='depart')!.amount=1;
    expectCode(()=>new SessionLedger(transfer),'invalid-ledger');
  });
  it('leaves all queued rebuys untouched if any pending participant would overflow contribution totals', () => {
    const ledger=pair();ledger.settleHand(1,{a:0,b:10000});ledger.queueRebuy('a','rebuy');
    // A malformed imported total must be rejected, never rounded into chip ownership.
    const snapshot=ledger.toJSON();snapshot.participants[0].totalBuyIn=Number.MAX_SAFE_INTEGER;
    expect(()=>new SessionLedger(snapshot)).toThrow();
    expect(ledger.toJSON().participants[0].pendingRebuyRequestId).toBe('rebuy');
  });
});
