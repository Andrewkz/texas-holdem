/** Pure ownership ledger. Hand-in-progress chips belong to the engine until settlement. */
export type SeatStatus = 'seated' | 'leaving-hand' | 'left';
export interface LedgerParticipant {
  playerId: string; nickname: string; seatStatus: SeatStatus;
  totalBuyIn: number; rebuyCount: number; stack: number; releasedChips: number;
  pendingDepartureHandId: number | null; pendingRebuyRequestId: string | null;
}
export interface LedgerEntry {
  id: string; playerId: string; type: 'initial' | 'rebuy' | 'depart' | 'rejoin' | 'hand-settlement';
  amount: number; handId: number; requestId: string | null;
}
export interface LedgerData {
  sessionId: string; committedHandId: number; participants: LedgerParticipant[];
  entries: LedgerEntry[]; appliedHands: { handId: number; stacks: Record<string, number> }[];
}
export class LedgerError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'LedgerError'; }
}
function fail(code: string, message: string): never { throw new LedgerError(code, message); }
function integer(value: unknown, signed = false): asserts value is number {
  if (!Number.isSafeInteger(value) || (!signed && (value as number) < 0)) fail('invalid-ledger', 'Chip amounts and hand IDs must be safe integers');
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length) fail('invalid-ledger', 'Expected a nonempty identifier');
}
function sum(values: number[]): number {
  let result = 0;
  for (const value of values) { result += value; integer(result, true); }
  return result;
}
const clone = <T>(value: T): T => structuredClone(value);

export class SessionLedger {
  private data: LedgerData;
  constructor(data: LedgerData) { this.data = clone(data); this.assertConserved(); }
  static create(sessionId: string): SessionLedger {
    return new SessionLedger({ sessionId, committedHandId: 0, participants: [], entries: [], appliedHands: [] });
  }
  toJSON(): LedgerData { return clone(this.data); }
  private participant(playerId: string): LedgerParticipant {
    const result = this.data.participants.find(p => p.playerId === playerId);
    if (!result) fail('participant-not-found', 'Participant does not belong to this session');
    return result;
  }
  private transaction<T>(operation: () => T): T {
    const previous = this.data; this.data = clone(previous);
    try { const result = operation(); this.assertConserved(); return clone(result); }
    catch (error) { this.data = previous; throw error; }
  }
  private append(playerId: string, type: LedgerEntry['type'], amount: number, handId: number, requestId: string | null = null): void {
    let n = this.data.entries.length + 1;
    while (this.data.entries.some(e => e.id === `entry-${n}`)) n++;
    this.data.entries.push({ id: `entry-${n}`, playerId, type, amount, handId, requestId });
  }
  addParticipant(playerId: string, nickname: string, requestId: string): LedgerParticipant {
    identifier(playerId); identifier(nickname); identifier(requestId);
    const priorRequest = this.data.entries.find(e => e.requestId === requestId);
    if (priorRequest && (priorRequest.playerId !== playerId || priorRequest.type !== 'initial')) fail('request-conflict', 'Request ID already belongs to another operation');
    if (this.data.participants.some(p => p.pendingRebuyRequestId === requestId)) fail('request-conflict', 'Request ID already belongs to a pending rebuy');
    const existing = this.data.participants.find(p => p.playerId === playerId);
    if (existing) {
      if (existing.nickname !== nickname) fail('participant-conflict', 'Participant nickname differs from its original admission');
      return clone(existing);
    }
    if (this.data.entries.some(e => e.requestId === requestId) || this.data.participants.some(p => p.pendingRebuyRequestId === requestId)) fail('request-conflict', 'Request ID already belongs to another operation');
    return this.transaction(() => {
      const participant: LedgerParticipant = { playerId, nickname, seatStatus: 'seated', totalBuyIn: 5000, rebuyCount: 0, stack: 5000, releasedChips: 0, pendingDepartureHandId: null, pendingRebuyRequestId: null };
      this.data.participants.push(participant);
      this.append(playerId, 'initial', 5000, this.data.committedHandId, requestId);
      return participant;
    });
  }
  queueRebuy(playerId: string, requestId: string): boolean {
    identifier(requestId);
    const p = this.participant(playerId);
    const prior = this.data.entries.find(e => e.requestId === requestId);
    if (prior) {
      if (prior.playerId === playerId && prior.type === 'rebuy') return false;
      fail('request-conflict', 'Request ID already belongs to another operation');
    }
    if (p.pendingRebuyRequestId === requestId) return false;
    if (this.data.participants.some(other => other.pendingRebuyRequestId === requestId)) fail('request-conflict', 'Request ID belongs to another participant');
    if (p.pendingRebuyRequestId !== null) fail('rebuy-pending', 'A different rebuy request is already pending');
    if (p.seatStatus !== 'seated' || p.stack !== 0 || p.pendingDepartureHandId !== null) fail('rebuy-ineligible', 'Only a settled, seated zero balance can receive a rebuy');
    return this.transaction(() => { this.participant(playerId).pendingRebuyRequestId = requestId; return true; });
  }
  applyPendingRebuys(nextHandId: number): string[] {
    integer(nextHandId);
    if (nextHandId <= this.data.committedHandId) fail('invalid-hand', 'Rebuy boundary must follow the latest committed hand');
    return this.transaction(() => {
      const applied: string[] = [];
      for (const p of this.data.participants) {
        if (p.pendingRebuyRequestId === null) continue;
        if (p.seatStatus !== 'seated' || p.stack !== 0) fail('rebuy-ineligible', 'Pending rebuy no longer has an eligible balance');
        const requestId = p.pendingRebuyRequestId;
        p.stack = 5000; p.totalBuyIn += 5000; p.rebuyCount++; p.pendingRebuyRequestId = null;
        this.append(p.playerId, 'rebuy', 5000, nextHandId, requestId); applied.push(requestId);
      }
      return applied;
    });
  }
  cancelPendingRebuys(playerId?: string): string[] {
    if (playerId !== undefined) this.participant(playerId);
    return this.transaction(() => {
      const canceled: string[] = [];
      for (const p of this.data.participants) if ((playerId === undefined || p.playerId === playerId) && p.pendingRebuyRequestId !== null) {
        canceled.push(p.pendingRebuyRequestId); p.pendingRebuyRequestId = null;
      }
      return canceled;
    });
  }
  private cashOut(p: LedgerParticipant, handId: number): void {
    const amount = p.stack;
    p.releasedChips += amount; p.stack = 0; p.seatStatus = 'left'; p.pendingDepartureHandId = null;
    this.append(p.playerId, 'depart', amount, handId);
  }
  requestDeparture(playerId: string, handId: number | null): void {
    const p = this.participant(playerId);
    if (p.seatStatus === 'left') return;
    if (p.seatStatus === 'leaving-hand') {
      if (handId === p.pendingDepartureHandId) return;
      fail('pending-equity', 'Departure is waiting for its hand settlement');
    }
    if (handId !== null) { integer(handId); if (handId <= this.data.committedHandId) fail('invalid-hand', 'Departure hand must be uncommitted'); }
    this.transaction(() => {
      const target = this.participant(playerId); target.pendingRebuyRequestId = null;
      if (handId === null) this.cashOut(target, this.data.committedHandId);
      else { target.seatStatus = 'leaving-hand'; target.pendingDepartureHandId = handId; }
    });
  }
  settleHand(handId: number, stacks: Record<string, number>): boolean {
    integer(handId);
    if (!stacks || typeof stacks !== 'object' || Array.isArray(stacks)) fail('invalid-ledger', 'Expected settlement balances');
    for (const value of Object.values(stacks)) integer(value);
    const prior = this.data.appliedHands.find(h => h.handId === handId);
    if (prior) {
      const keys = Object.keys(stacks);
      if (keys.length === Object.keys(prior.stacks).length && keys.every(k => Object.hasOwn(prior.stacks, k) && prior.stacks[k] === stacks[k])) return false;
      fail('hand-conflict', 'This hand already has a different committed result');
    }
    if (handId <= this.data.committedHandId) fail('invalid-hand', 'Hand IDs must increase');
    const keys = Object.keys(stacks);
    if (!keys.length) fail('invalid-hand', 'A settled hand must contain participants');
    const participants = keys.map(k => this.participant(k));
    if (participants.some(p => p.seatStatus === 'left')) fail('invalid-hand', 'Departed participants cannot play a hand');
    if (this.data.participants.some(p => p.pendingDepartureHandId !== null && (p.pendingDepartureHandId !== handId || !Object.hasOwn(stacks,p.playerId)))) fail('pending-equity', 'Settlement must include every pending hand departure');
    if (sum(participants.map(p => p.stack)) !== sum(Object.values(stacks))) fail('not-conserved', 'A complete hand cannot create or destroy chips');
    return this.transaction(() => {
      for (const playerId of keys) {
        const p = this.participant(playerId); const delta = stacks[playerId] - p.stack;
        p.stack = stacks[playerId]; this.append(playerId, 'hand-settlement', delta, handId);
        if (p.pendingDepartureHandId === handId) this.cashOut(p, handId);
      }
      this.data.committedHandId = handId;
      this.data.appliedHands.push({ handId, stacks: clone(stacks) });
      return true;
    });
  }
  /** Roll back engine-only changes while honoring durable departure intents. */
  resolveRolledBackHand(handId: number): string[] {
    integer(handId);
    if (handId <= this.data.committedHandId) fail('invalid-hand', 'Rollback must name an uncommitted hand');
    return this.transaction(() => {
      const departed: string[] = [];
      for (const p of this.data.participants) if (p.pendingDepartureHandId === handId) {
        this.cashOut(p, this.data.committedHandId); departed.push(p.playerId);
      }
      return departed;
    });
  }
  rejoin(playerId: string): void {
    const p = this.participant(playerId);
    if (p.seatStatus === 'leaving-hand') fail('pending-equity', 'Hand equity has not settled yet');
    if (p.seatStatus === 'seated') return;
    this.transaction(() => {
      const target = this.participant(playerId); const amount = target.releasedChips;
      target.stack += amount; target.releasedChips = 0; target.seatStatus = 'seated';
      this.append(playerId, 'rejoin', amount, this.data.committedHandId);
    });
  }
  assertConserved(): void {
    const d = this.data;
    if (!d || typeof d !== 'object') fail('invalid-ledger', 'Invalid ledger');
    identifier(d.sessionId); integer(d.committedHandId);
    if (!Array.isArray(d.participants) || !Array.isArray(d.entries) || !Array.isArray(d.appliedHands)) fail('invalid-ledger', 'Invalid ledger collections');
    const playerIds = new Set<string>(); const requestIds = new Set<string>(); const entryIds = new Set<string>();
    for (const p of d.participants) {
      identifier(p.playerId); identifier(p.nickname);
      if (playerIds.has(p.playerId)) fail('invalid-ledger', 'Duplicate participant'); playerIds.add(p.playerId);
      for (const n of [p.totalBuyIn,p.rebuyCount,p.stack,p.releasedChips]) integer(n);
      if (!['seated','leaving-hand','left'].includes(p.seatStatus)) fail('invalid-ledger', 'Invalid seat status');
      if (p.pendingDepartureHandId !== null) { integer(p.pendingDepartureHandId); if (p.pendingDepartureHandId <= d.committedHandId) fail('invalid-ledger', 'Departure hand is already committed'); }
      if ((p.seatStatus === 'leaving-hand') !== (p.pendingDepartureHandId !== null)) fail('invalid-ledger', 'Pending departure and seat status disagree');
      if (p.seatStatus === 'left' ? p.stack !== 0 : p.releasedChips !== 0) fail('invalid-ledger', 'Chips must have one ownership location');
      if (p.pendingRebuyRequestId !== null) {
        identifier(p.pendingRebuyRequestId);
        if (p.seatStatus !== 'seated' || p.stack !== 0 || requestIds.has(p.pendingRebuyRequestId)) fail('invalid-ledger', 'Invalid pending rebuy');
        requestIds.add(p.pendingRebuyRequestId);
      }
      if (p.totalBuyIn !== 5000 * (p.rebuyCount + 1)) fail('invalid-ledger', 'Buy-in and rebuy count disagree');
    }
    for (const e of d.entries) {
      identifier(e.id); identifier(e.playerId); integer(e.handId); integer(e.amount, e.type === 'hand-settlement');
      if (!playerIds.has(e.playerId) || entryIds.has(e.id) || !['initial','rebuy','depart','rejoin','hand-settlement'].includes(e.type)) fail('invalid-ledger', 'Invalid ledger entry');
      entryIds.add(e.id);
      if (e.requestId !== null) { identifier(e.requestId); if(requestIds.has(e.requestId)) fail('invalid-ledger', 'Duplicate request'); requestIds.add(e.requestId); }
      if ((e.type === 'initial' || e.type === 'rebuy') && (e.amount !== 5000 || e.requestId === null)) fail('invalid-ledger', 'Invalid contribution event');
    }
    let lastHand = 0;
    for (const hand of d.appliedHands) {
      integer(hand.handId);
      if (hand.handId <= lastHand || hand.handId > d.committedHandId || !hand.stacks || Array.isArray(hand.stacks) || typeof hand.stacks !== 'object') fail('invalid-ledger', 'Invalid applied hand');
      for (const [id, amount] of Object.entries(hand.stacks)) { if (!playerIds.has(id)) fail('invalid-ledger', 'Unknown settled participant'); integer(amount); }
      lastHand = hand.handId;
    }
    if (lastHand !== d.committedHandId) fail('invalid-ledger', 'Committed hand does not match history');
    for (const hand of d.appliedHands) {
      const settlements = d.entries.filter(e => e.type === 'hand-settlement' && e.handId === hand.handId);
      const ids = Object.keys(hand.stacks);
      if (!ids.length || settlements.length !== ids.length || ids.some(id => settlements.filter(e => e.playerId === id).length !== 1) || sum(settlements.map(e => e.amount)) !== 0) fail('invalid-ledger', 'Applied hand must have one conserving event per participant');
    }

    for (const p of d.participants) {
      const events = d.entries.filter(e => e.playerId === p.playerId);
      if (events.filter(e => e.type === 'initial').length !== 1 || events.filter(e => e.type === 'rebuy').length !== p.rebuyCount) fail('invalid-ledger', 'Contribution history disagrees');
      let replayStack = 0; let replayReleased = 0; let replayLeft = false;
      for (const e of events) {
        if (e.type === 'initial' || e.type === 'rebuy') {
          if (replayLeft || (e.type === 'rebuy' && replayStack !== 0)) fail('invalid-ledger', 'Contribution history has an ineligible balance');
          replayStack = sum([replayStack, e.amount]);
        } else if (e.type === 'hand-settlement') {
          const hand = d.appliedHands.find(h => h.handId === e.handId);
          replayStack = sum([replayStack, e.amount]);
          if (replayLeft || replayStack < 0 || !hand || !Object.hasOwn(hand.stacks, p.playerId) || hand.stacks[p.playerId] !== replayStack) fail('invalid-ledger', 'Settlement event disagrees with applied hand');
        } else if (e.type === 'depart') {
          if (replayLeft || e.amount !== replayStack) fail('invalid-ledger', 'Departure event disagrees with balance');
          replayReleased = sum([replayReleased, e.amount]); replayStack = 0; replayLeft = true;
        } else if (e.type === 'rejoin') {
          if (!replayLeft || e.amount !== replayReleased) fail('invalid-ledger', 'Rejoin event disagrees with released ownership');
          replayStack = sum([replayStack, e.amount]); replayReleased = 0; replayLeft = false;
        }
      }
      if (replayStack !== p.stack || replayReleased !== p.releasedChips) fail('not-conserved', 'Balance disagrees with event transfers');
      if (replayLeft !== (p.seatStatus === 'left')) fail('invalid-ledger', 'Seat status disagrees with event transfers');
      const ownership = sum(events.filter(e => e.type === 'initial' || e.type === 'rebuy' || e.type === 'hand-settlement').map(e => e.amount));
      if (sum([p.stack,p.releasedChips]) !== ownership) fail('not-conserved', 'Participant ownership differs from its event history');
    }
    if (sum(d.participants.map(p => sum([p.stack,p.releasedChips]))) !== sum(d.participants.map(p => p.totalBuyIn))) fail('not-conserved', 'Session chip total differs from contributions');
  }
}
