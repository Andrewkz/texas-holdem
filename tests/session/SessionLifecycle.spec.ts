import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMatchStore } from '../../server/src/session/FileMatchStore';
import { validateMatchRecord } from '../../server/src/session/MatchRecord';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Deck } from '../../assets/scripts/core/Deck';
import type { Card } from '../../assets/scripts/core/types';
import { RoomManager } from '../../server/src/RoomManager';
import { MemoryMatchStore } from '../../server/src/session/MemoryMatchStore';
import type { MatchRecord } from '../../server/src/session/MatchRecord';
import { connect, createRoom, joinRoom } from '../net/fakes';
import { sendCommand, setBoundaryStacks } from '../net/v3Commands';
const managers: RoomManager[] = [];
function manager(options: ConstructorParameters<typeof RoomManager>[0] = {}) {
  const m = new RoomManager({ actionTimeoutMs: 1000000, betweenHandsMs: 100, ...options });
  managers.push(m);
  return m;
}
function table(m: RoomManager) {
  const a = createRoom(m);
  const b = joinRoom(m, a.joined.roomCode, 'Bob');
  return { a, b, room: m.getRoom(a.joined.sessionId)! };
}
function foldToEnd(m: RoomManager, peers: ReturnType<typeof createRoom>[]) {
  for (let i = 0; i < 12; i++) {
    const state = peers.map(p => p.connection.last('stateSync')).find(s => s?.snapshot.actingPlayerId);
    if (!state || state.snapshot.street === 'settled')
      break;
    const actor = peers.find(p => p.joined.playerId === state.snapshot.actingPlayerId)!;
    sendCommand(m, actor.connection, { type: 'action', action: { type: 'fold' } });
  }
}
describe('durable session integration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const m of managers.splice(0))
      m.dispose();
    vi.useRealTimers();
  });
  it('deduplicates unacknowledged create and join using request plus proof and rejects altered payload', () => {
    const m = manager();
    const first = connect(m);
    const command = { type: 'createRoom' as const, nickname: 'A', requestId: randomUUID(), token: randomBytes(32).toString('hex') };
    m.handleMessage(first, command);
    const joined = first.last('joined')!;
    const retry = connect(m);
    m.handleMessage(retry, command);
    expect(retry.last('joined')?.playerId).toBe(joined.playerId);
    expect(m.roomCount()).toBe(1);
    expect(m.records()[0].ledger.entries).toHaveLength(1);
    const j = { type: 'joinRoom' as const, roomCode: joined.roomCode, sessionId: joined.sessionId, nickname: 'B', requestId: randomUUID(), token: randomBytes(32).toString('hex') };
    const peer = connect(m);
    m.handleMessage(peer, j);
    const again = connect(m);
    m.handleMessage(again, j);
    expect(again.last('joined')?.playerId).toBe(peer.last('joined')?.playerId);
    expect(m.records()[0].ledger.participants).toHaveLength(2);
    const bad = connect(m);
    m.handleMessage(bad, { ...j, nickname: 'Changed' });
    expect(bad.last('error')?.code).toBe('request-conflict');
    expect(JSON.stringify(m.records())).not.toContain(command.token);
  });
  it('retains more than six historical identities and returns original released balance on explicit rejoin', () => {
    const m = manager();
    const { a, b, room } = table(m);
    sendCommand(m, b.connection, { type: 'leaveRoom' });
    const left = room.ledgerSnapshot().rows.find(p => p.playerId === b.joined.playerId)!;
    expect(left).toMatchObject({ seatStatus: 'left', releasedChips: 5000, stack: 0, totalBuyIn: 5000 });
    const back = connect(m);
    m.handleMessage(back, { type: 'rejoin', sessionId: room.sessionId, token: b.joined.token, requestId: 'back' });
    expect(back.last('joined')?.playerId).toBe(b.joined.playerId);
    expect(room.ledgerSnapshot().rows.find(p => p.playerId === b.joined.playerId)).toMatchObject({ stack: 5000, releasedChips: 0, totalBuyIn: 5000 });
    sendCommand(m, back, { type: 'leaveRoom' });
    for (let i = 0; i < 7; i++) {
      const p = joinRoom(m, a.joined.roomCode, `p${i}`);
      sendCommand(m, p.connection, { type: 'leaveRoom' });
    }
    expect(room.ledgerSnapshot().rows).toHaveLength(9);
    expect(room.roomState().seats).toHaveLength(1);
  });
  it('preserves all-in leaver pot eligibility and rejects rejoin until equity is settled', () => {
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const m = manager();
    const { a, b, room } = table(m);
    const c = joinRoom(m, a.joined.roomCode, 'Carol');
    sendCommand(m, a.connection, { type: 'startGame' });
    sendCommand(m, a.connection, { type: 'action', action: { type: 'all-in' } });
    sendCommand(m, a.connection, { type: 'leaveRoom' });
    const back = connect(m);
    m.handleMessage(back, { type: 'rejoin', sessionId: room.sessionId, token: a.joined.token, requestId: 'too-early' });
    expect(back.last('commandResult')?.result).toMatchObject({ status: 'rejected', code: 'pending-equity' });
    sendCommand(m, b.connection, { type: 'action', action: { type: 'all-in' } });
    sendCommand(m, c.connection, { type: 'action', action: { type: 'all-in' } });
    rng.mockRestore();
    const result = b.connection.last('handResult')!;
    expect(result.payouts.reduce((sum, p) => sum + p.amount, 0)).toBe(15000);
    expect(b.connection.last('showdown')?.reveals.map(p => p.playerId)).toContain(a.joined.playerId);
    const row = room.ledgerSnapshot().rows.find(p => p.playerId === a.joined.playerId)!;
    expect(row.seatStatus).toBe('left');
    expect(row.stack).toBe(0);
    expect(row.pendingDepartureHandId).toBeNull();
  });
  it('queues a settled zero balance exactly once and atomically applies it at the next-hand boundary', () => {
    const m = manager();
    const { a, b, room } = table(m);
    setBoundaryStacks(room, { [a.joined.playerId]: 0, [b.joined.playerId]: 10000 });
    const command = { type: 'rebuy' as const, sessionId: room.sessionId, requestId: 'rebuy-once' };
    m.handleMessage(a.connection, command);
    m.handleMessage(a.connection, command);
    expect(room.ledgerSnapshot().rows[0]).toMatchObject({ stack: 0, totalBuyIn: 5000, pendingRebuyRequestId: 'rebuy-once' });
    // A zero balance can queue before the host restarts a table; the boundary makes two stacks playable.
    sendCommand(m, b.connection, { type: 'leaveRoom' });
    expect(room.commandStatus(a.joined.playerId, 'rebuy-once')?.status).toBe('pending');
    const c = joinRoom(m, a.joined.roomCode, 'Carol');
    sendCommand(m, a.connection, { type: 'startGame' });
    expect(c.connection.last('handStart')).toBeDefined();
    expect(room.ledgerSnapshot().rows[0]).toMatchObject({ stack: 5000, totalBuyIn: 10000, rebuyCount: 1, pendingRebuyRequestId: null });
    expect(room.commandStatus(a.joined.playerId, 'rebuy-once')?.status).toBe('committed');
    expect(room.snapshotRecord().inFlightHandId).not.toBeNull();
  });
  it('finishes the current hand after host end, fixes one final snapshot, and never deals another hand', () => {
    const m = manager();
    const { a, b, room } = table(m);
    sendCommand(m, a.connection, { type: 'startGame' });
    const cmd = { type: 'requestEnd' as const, sessionId: room.sessionId, requestId: 'end-once' };
    m.handleMessage(a.connection, cmd);
    expect(room.lifecycle).toBe('ending-after-hand');
    expect(a.connection.last('sessionEnded')).toBeUndefined();
    foldToEnd(m, [a, b]);
    const final = room.snapshotRecord().settlement!;
    expect(final.rows.reduce((sum, p) => sum + p.net, 0)).toBe(0);
    m.handleMessage(a.connection, cmd);
    vi.advanceTimersByTime(10000);
    expect(room.snapshotRecord().settlement).toEqual(final);
    expect(a.connection.sent.filter(m => m.type === 'handStart')).toHaveLength(1);
    expect(a.connection.sent.at(-1)?.type).toBe('commandResult');
    expect(a.connection.sent.findIndex(m => m.type === 'sessionEnded')).toBeGreaterThan(a.connection.sent.findIndex(m => m.type === 'handResult'));
  });
  it('last explicit departure normally resolves a current hand and retains all historical balances', () => {
    const m = manager();
    const { a, b, room } = table(m);
    sendCommand(m, a.connection, { type: 'startGame' });
    sendCommand(m, a.connection, { type: 'leaveRoom' });
    sendCommand(m, b.connection, { type: 'leaveRoom' });
    expect(room.lifecycle).toBe('ended');
    expect(room.snapshotRecord().settlement?.reason).toBe('last-player-left');
    expect(room.snapshotRecord().settlement?.recoveryNotice).toBeNull();
    expect(room.snapshotRecord().settlement?.rows).toHaveLength(2);
    expect(m.roomCount()).toBe(0);
  });
  it('uses the absolute all-offline deadline at 179999/180000 and rolls back unresolved equity', () => {
    const m = manager();
    const { a, b, room } = table(m);
    sendCommand(m, a.connection, { type: 'startGame' });
    m.handleClose(a.connection);
    m.handleClose(b.connection);
    const deadline = room.snapshotRecord().allOfflineDeadline!;
    vi.setSystemTime(deadline - 1);
    room.expireIfNeeded();
    expect(room.lifecycle).toBe('all-offline-wait');
    vi.setSystemTime(deadline);
    room.expireIfNeeded();
    expect(room.lifecycle).toBe('ended');
    expect(room.snapshotRecord().settlement?.rows.map(p => p.finalChips)).toEqual([5000, 5000]);
    expect(room.snapshotRecord().recoveryNotice).toMatchObject({ rolledBackHandId: 1, reason: 'all-offline-timeout' });
  });
  it('keeps the all-offline deadline across restart, preserves joins/departures and rejects old table epochs', () => {
    const store = new MemoryMatchStore<MatchRecord>();
    const m = manager({ store });
    const { a, b, room } = table(m);
    const retained = joinRoom(m, a.joined.roomCode, 'Daria');
    sendCommand(m, a.connection, { type: 'startGame' });
    const old = room.tableEpoch;
    sendCommand(m, b.connection, { type: 'leaveRoom' });
    const c = joinRoom(m, a.joined.roomCode, 'Carol');
    m.handleClose(a.connection);
    m.handleClose(c.connection);
    m.handleClose(retained.connection);
    const deadline = room.snapshotRecord().allOfflineDeadline!;
    m.dispose();
    vi.setSystemTime(deadline - 1000);
    const restored = manager({ store });
    const next = restored.getRoom(room.sessionId)!;
    expect(next.tableEpoch).not.toBe(old);
    expect(next.snapshotRecord().allOfflineDeadline).toBe(deadline);
    expect(next.ledgerSnapshot().rows.find(p => p.playerId === b.joined.playerId)).toMatchObject({ seatStatus: 'left', releasedChips: 5000 });
    expect(next.ledgerSnapshot().rows.find(p => p.playerId === c.joined.playerId)?.stack).toBe(5000);
    const back = connect(restored);
    restored.handleMessage(back, { type: 'reconnect', sessionId: room.sessionId, token: a.joined.token });
    expect(back.last('recoveryNotice')?.notice.reason).toBe('server-restart');
    restored.handleMessage(back, { type: 'action', sessionId: room.sessionId, tableEpoch: old, handId: 1, action: { type: 'fold' } });
    expect(back.last('error')?.code).toBe('stale-action');
  });
  it('authenticates command-status reads after a committed leave without reoccupying the seat', () => {
    const m = manager();
    const { a, b, room } = table(m);
    m.handleMessage(b.connection, { type: 'leaveRoom', sessionId: room.sessionId, requestId: 'lost-leave' });
    const released = room.ledgerSnapshot();
    const fresh = connect(m);
    m.handleMessage(fresh, { type: 'commandStatus', sessionId: room.sessionId, requestId: 'lost-leave', token: b.joined.token } as any);
    expect(fresh.last('commandResult')?.result).toMatchObject({ command: 'leaveRoom', status: 'committed', requestId: 'lost-leave' });
    expect(fresh.last('joined')).toBeUndefined();
    expect(room.ledgerSnapshot()).toEqual(released);
    const invalid = connect(m);
    m.handleMessage(invalid, { type: 'commandStatus', sessionId: room.sessionId, requestId: 'lost-leave', token: a.joined.token } as any);
    expect(invalid.last('commandResult')).toBeUndefined();
    expect(invalid.last('error')?.code).toBe('command-not-found');
    const bad = connect(m);
    m.handleMessage(bad, { type: 'commandStatus', sessionId: room.sessionId, requestId: 'lost-leave', token: 'unknown' } as any);
    expect(bad.last('error')?.code).toBe('invalid-proof');
  });
  it('settles deterministic six-player main/side pots and unmatched chips for departed all-in identities', () => {
    const m = manager();
    const a = createRoom(m);
    const peers = [a, ...['B', 'C', 'D', 'E', 'F'].map(n => joinRoom(m, a.joined.roomCode, n))];
    const room = m.getRoom(a.joined.sessionId)!;
    setBoundaryStacks(room, Object.fromEntries(peers.map((p, i) => [p.joined.playerId, 100 * (i + 1)])));
    const cards: Card[] = [{ suit: 'S', rank: 14 }, { suit: 'H', rank: 14 }, { suit: 'S', rank: 13 }, { suit: 'H', rank: 13 }, { suit: 'S', rank: 12 }, { suit: 'H', rank: 12 }, { suit: 'S', rank: 11 }, { suit: 'H', rank: 11 }, { suit: 'S', rank: 10 }, { suit: 'H', rank: 10 }, { suit: 'S', rank: 6 }, { suit: 'H', rank: 6 }, { suit: 'C', rank: 2 }, { suit: 'D', rank: 3 }, { suit: 'H', rank: 7 }, { suit: 'S', rank: 8 }, { suit: 'C', rank: 9 }];
    const draw = vi.spyOn(Deck.prototype, 'draw').mockImplementation(() => {
      const card = cards.shift();
      if (!card)
        throw new Error('missing deterministic card');
      return card;
    });
    sendCommand(m, a.connection, { type: 'startGame' });
    for (let i = 0; i < 6; i++) {
      const sync = peers[2].connection.last('stateSync')!;
      const actor = peers.find(p => p.joined.playerId === sync.snapshot.actingPlayerId)!;
      sendCommand(m, actor.connection, { type: 'action', action: { type: 'all-in' } });
      if ([peers[0], peers[1], peers[3]].includes(actor))
        sendCommand(m, actor.connection, { type: 'leaveRoom' });
    }
    draw.mockRestore();
    const rows = room.ledgerSnapshot().rows;
    expect(peers.map(p => {
      const row = rows.find(r => r.playerId === p.joined.playerId)!;
      return row.stack + row.releasedChips;
    })).toEqual([600, 500, 400, 300, 200, 100]);
    for (const p of [peers[0], peers[1], peers[3]])
      expect(rows.find(r => r.playerId === p.joined.playerId)?.seatStatus).toBe('left');
    expect(rows.reduce((sum, p) => sum + p.stack + p.releasedChips - p.totalBuyIn, 0)).toBe(0);
  });
  it('preserves departed all-in shares when a board ties both main and side pots', () => {
    const m = manager();
    const { a, b, room } = table(m);
    const c = joinRoom(m, a.joined.roomCode, 'Carol');
    const peers = [a, b, c];
    setBoundaryStacks(room, { [a.joined.playerId]: 100, [b.joined.playerId]: 200, [c.joined.playerId]: 300 });
    const cards: Card[] = [2, 3, 4, 5, 6, 7].map(rank => ({ suit: 'C', rank } as Card)).concat([10, 11, 12, 13, 14].map(rank => ({ suit: 'S', rank } as Card)));
    const draw = vi.spyOn(Deck.prototype, 'draw').mockImplementation(() => cards.shift()!);
    sendCommand(m, a.connection, { type: 'startGame' });
    for (const p of peers) {
      sendCommand(m, p.connection, { type: 'action', action: { type: 'all-in' } });
      if (p !== c)
        sendCommand(m, p.connection, { type: 'leaveRoom' });
    }
    draw.mockRestore();
    expect(peers.map(p => {
      const row = room.ledgerSnapshot().rows.find(r => r.playerId === p.joined.playerId)!;
      return row.stack + row.releasedChips;
    })).toEqual([100, 200, 300]);
    expect(room.snapshotRecord().inFlightHandId).toBeNull();
  });
  it.each(['preflop', 'flop', 'turn', 'river'])('finishes the existing %s hand after host end while rejecting non-host and stale connections', (street) => {
    const m = manager();
    const { a, b, room } = table(m);
    const peers = [a, b];
    sendCommand(m, a.connection, { type: 'startGame' });
    for (let guard = 0; guard < 12; guard++) {
      const snapshot = b.connection.last('stateSync')!.snapshot;
      if (snapshot.street === street)
        break;
      const actor = peers.find(p => p.joined.playerId === snapshot.actingPlayerId)!;
      const action = actor.connection.last('stateSync')!.snapshot.legalActions.find(a => a.type === 'check') ?? actor.connection.last('stateSync')!.snapshot.legalActions.find(a => a.type === 'call')!;
      sendCommand(m, actor.connection, { type: 'action', action });
    }
    sendCommand(m, b.connection, { type: 'requestEnd' });
    expect(b.connection.last('commandResult')?.result).toMatchObject({ status: 'rejected', code: 'not-host' });
    expect(room.lifecycle).toBe('active');
    sendCommand(m, a.connection, { type: 'requestEnd' });
    expect(room.lifecycle).toBe('ending-after-hand');
    foldToEnd(m, peers);
    expect(room.lifecycle).toBe('ended');
    expect(room.snapshotRecord().settlement?.rows.reduce((sum, p) => sum + p.net, 0)).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(a.connection.sent.filter(m => m.type === 'handStart')).toHaveLength(1);
  });
  it('valid recovery at 179999 cancels the old deadline and only a later final disconnect establishes another', () => {
    const m = manager();
    const { a, b, room } = table(m);
    m.handleClose(a.connection);
    m.handleClose(b.connection);
    const deadline = room.snapshotRecord().allOfflineDeadline!;
    vi.setSystemTime(deadline - 1);
    const back = connect(m);
    m.handleMessage(back, { type: 'reconnect', sessionId: room.sessionId, token: a.joined.token });
    expect(back.last('joined')).toBeDefined();
    expect(room.snapshotRecord().allOfflineDeadline).toBeNull();
    vi.advanceTimersByTime(1);
    expect(room.lifecycle).toBe('active');
    m.handleClose(back);
    const newDeadline = room.snapshotRecord().allOfflineDeadline!;
    expect(newDeadline).toBe(deadline + 180000);
    m.handleClose(back);
    expect(room.snapshotRecord().allOfflineDeadline).toBe(newDeadline);
  });
  it('preserves a newly committed complete hand during all-offline wait and finalizes that boundary', () => {
    const m = manager({ actionTimeoutMs: 1000 });
    const { a, b, room } = table(m);
    sendCommand(m, a.connection, { type: 'startGame' });
    m.handleClose(a.connection);
    m.handleClose(b.connection);
    vi.advanceTimersByTime(1000);
    expect(room.snapshotRecord().ledger.committedHandId).toBe(1);
    const stacks = room.ledgerSnapshot().rows.map(p => p.stack);
    vi.advanceTimersByTime(179000);
    expect(room.snapshotRecord().settlement?.rows.map(p => p.finalChips)).toEqual(stacks);
    expect(room.snapshotRecord().settlement?.recoveryNotice).toBeNull();
    expect(a.connection.sent.filter(m => m.type === 'handStart')).toHaveLength(1);
  });
  it('valid recovery cancels an all-offline deadline even when host end is already pending', () => {
    const m = manager();
    const { a, b, room } = table(m);
    sendCommand(m, a.connection, { type: 'startGame' });
    sendCommand(m, a.connection, { type: 'requestEnd' });
    m.handleClose(a.connection);
    m.handleClose(b.connection);
    const deadline = room.snapshotRecord().allOfflineDeadline!;
    vi.setSystemTime(deadline - 1);
    const back = connect(m);
    m.handleMessage(back, { type: 'reconnect', sessionId: room.sessionId, token: a.joined.token });
    expect(room.lifecycle).toBe('ending-after-hand');
    expect(room.snapshotRecord().allOfflineDeadline).toBeNull();
    vi.advanceTimersByTime(1);
    expect(room.lifecycle).toBe('ending-after-hand');
  });
  it('resumes the next hand after recovering a hand that completed while everyone was offline', () => {
    const m = manager({ actionTimeoutMs: 1000 });
    const { a, b, room } = table(m);
    sendCommand(m, a.connection, { type: 'startGame' });
    m.handleClose(a.connection);
    m.handleClose(b.connection);
    vi.advanceTimersByTime(1100);
    expect(room.snapshotRecord().ledger.committedHandId).toBe(1);
    const back = connect(m);
    m.handleMessage(back, { type: 'reconnect', sessionId: room.sessionId, token: a.joined.token });
    vi.advanceTimersByTime(100);
    expect(back.last('handStart')?.handId).toBe(2);
    expect(room.snapshotRecord().inFlightHandId).toBe(2);
  });
  it('rotates past a dealer who left during the hand after earlier seats were also removed', () => {
    const m = manager();
    const a = createRoom(m);
    const peers = [a, ...['B', 'C', 'D'].map(n => joinRoom(m, a.joined.roomCode, n))];
    const room = m.getRoom(a.joined.sessionId)!;
    sendCommand(m, a.connection, { type: 'startGame' });
    foldToEnd(m, peers);
    vi.advanceTimersByTime(100);
    expect(peers[2].connection.last('handStart')?.dealerPlayerId).toBe(peers[1].joined.playerId);
    sendCommand(m, a.connection, { type: 'leaveRoom' });
    sendCommand(m, peers[1].connection, { type: 'leaveRoom' });
    foldToEnd(m, peers.slice(2));
    vi.advanceTimersByTime(100);
    expect(peers[2].connection.last('handStart')?.dealerPlayerId).toBe(peers[2].joined.playerId);
    expect(room.snapshotRecord().inFlightHandId).toBe(3);
  });
  it('single-seat cleanup during all-offline wait cannot delete the session or change the absolute deadline', () => {
    const m = manager();
    const { a, b, room } = table(m);
    m.handleClose(a.connection);
    vi.advanceTimersByTime(1000);
    m.handleClose(b.connection);
    const deadline = room.snapshotRecord().allOfflineDeadline!;
    vi.advanceTimersByTime(179000);
    expect(room.lifecycle).toBe('all-offline-wait');
    expect(room.snapshotRecord().allOfflineDeadline).toBe(deadline);
    expect(room.ledgerSnapshot().rows.find(p => p.playerId === a.joined.playerId)?.seatStatus).toBe('left');
    expect(m.roomCount()).toBe(1);
    vi.advanceTimersByTime(999);
    expect(room.lifecycle).toBe('all-offline-wait');
    vi.advanceTimersByTime(1);
    expect(room.lifecycle).toBe('ended');
    expect(room.snapshotRecord().settlement?.rows).toHaveLength(2);
  });
  it('reschedules early timer callbacks until the persisted wall-clock deadline is actually reached', () => {
    const m = manager();
    const { a, b, room } = table(m);
    m.handleClose(a.connection);
    m.handleClose(b.connection);
    const deadline = room.snapshotRecord().allOfflineDeadline!;
    const now = vi.spyOn(Date, 'now').mockReturnValue(deadline - 1);
    vi.advanceTimersByTime(180000);
    expect(room.lifecycle).toBe('all-offline-wait');
    expect(room.ledgerSnapshot().rows.every(p => p.seatStatus === 'seated')).toBe(true);
    now.mockReturnValue(deadline);
    vi.advanceTimersByTime(1);
    expect(room.lifecycle).toBe('ended');
    now.mockRestore();
  });
  it('ordinary out-of-turn departure immediately loses eligibility and cannot collect a later fold pot', () => {
    const m = manager();
    const { a, b, room } = table(m);
    sendCommand(m, a.connection, { type: 'startGame' });
    sendCommand(m, a.connection, { type: 'action', action: { type: 'call', amount: 20 } });
    expect(b.connection.last('stateSync')?.snapshot.actingPlayerId).toBe(b.joined.playerId);
    sendCommand(m, a.connection, { type: 'leaveRoom' });
    expect(room.snapshotRecord().inFlightHandId).toBeNull();
    expect(b.connection.last('handResult')?.payouts).toEqual([expect.objectContaining({ playerId: b.joined.playerId, amount: 80 })]);
    expect(room.ledgerSnapshot().rows.find(p => p.playerId === a.joined.playerId)).toMatchObject({ seatStatus: 'left', releasedChips: 4960 });
    sendCommand(m, b.connection, { type: 'leaveRoom' });
    expect(room.snapshotRecord().settlement?.rows.map(p => p.finalChips)).toEqual([4960, 5040]);
    expect(b.connection.sent.filter(m => m.type === 'handResult')).toHaveLength(1);
    expect(b.connection.sent.filter(m => m.type === 'sessionEnded')).toHaveLength(1);
  });
  it('immediately folds multiple out-of-turn leavers while preserving the live actor and commits once', () => {
    const m = manager();
    const a = createRoom(m);
    const peers = [a, ...['B', 'C', 'D'].map(n => joinRoom(m, a.joined.roomCode, n))];
    const room = m.getRoom(a.joined.sessionId)!;
    sendCommand(m, a.connection, { type: 'startGame' });
    const actor = peers[3];
    expect(actor.connection.last('stateSync')?.snapshot.actingPlayerId).toBe(actor.joined.playerId);
    sendCommand(m, peers[1].connection, { type: 'leaveRoom' });
    sendCommand(m, peers[2].connection, { type: 'leaveRoom' });
    expect(actor.connection.last('stateSync')?.snapshot.actingPlayerId).toBe(actor.joined.playerId);
    expect(actor.connection.last('stateSync')?.snapshot.players.filter(p => p.folded).map(p => p.id)).toEqual([peers[1].joined.playerId, peers[2].joined.playerId]);
    sendCommand(m, a.connection, { type: 'leaveRoom' });
    expect(room.snapshotRecord().ledger.committedHandId).toBe(1);
    expect(actor.connection.last('handResult')?.payouts[0].playerId).toBe(actor.joined.playerId);
    vi.advanceTimersByTime(100);
    expect(actor.connection.sent.filter(m => m.type === 'handStart')).toHaveLength(1);
    expect(room.phase).toBe('lobby');
  });
  it('settles only actual dealt participants when an undealt zero-stack seat leaves', () => {
    const m = manager();
    const { a, b, room } = table(m);
    const c = joinRoom(m, a.joined.roomCode, 'Carol');
    setBoundaryStacks(room, { [a.joined.playerId]: 0, [b.joined.playerId]: 7500, [c.joined.playerId]: 7500 });
    sendCommand(m, a.connection, { type: 'startGame' });
    expect(b.connection.last('handStart')?.participantIds).toEqual([b.joined.playerId, c.joined.playerId]);
    sendCommand(m, a.connection, { type: 'leaveRoom' });
    sendCommand(m, b.connection, { type: 'action', action: { type: 'fold' } });
    expect(b.connection.last('handResult')).toBeDefined();
    expect(room.snapshotRecord().inFlightHandId).toBeNull();
    expect(room.snapshotRecord().checkpointVersion).toBe(2);
    expect(room.paused).toBe(false);
    expect(room.ledgerSnapshot().rows.find(p => p.playerId === a.joined.playerId)).toMatchObject({ seatStatus: 'left', releasedChips: 0 });
    expect(b.connection.last('error')).toBeUndefined();
  });
  it('elects an online newcomer only after the retained host candidates expire', () => {
    const m = manager({ reconnectWindowMs: 2000 });
    const { a, b, room } = table(m);
    m.handleClose(b.connection);
    sendCommand(m, a.connection, { type: 'leaveRoom' });
    const c = joinRoom(m, a.joined.roomCode, 'Carol');
    joinRoom(m, a.joined.roomCode, 'Dave');
    expect(room.hostId).toBe('');
    vi.advanceTimersByTime(1999);
    expect(room.hostId).toBe('');
    vi.advanceTimersByTime(1);
    expect(room.hostId).toBe(c.joined.playerId);
    sendCommand(m, c.connection, { type: 'startGame' });
    expect(c.connection.last('handStart')).toBeDefined();
  });
  it('reports an uncertain missing receipt after an actual post-rename file-store failure', () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'poker-uncertain-'));
    let fail = false;
    const store = new FileMatchStore(directory, validateMatchRecord, { at: (point) => {
        if (fail && point === 'after-rename')
          throw new Error('lost-directory-confirmation');
      } });
    try {
      const m = manager({ store });
      const { a, room } = table(m);
      fail = true;
      sendCommand(m, a.connection, { type: 'requestEnd', requestId: 'rename-end' });
      expect(room.paused).toBe(true);
      const disk = validateMatchRecord(JSON.parse(readFileSync(join(directory, `${room.sessionId}.json`), 'utf8')));
      expect(disk.commands.find(c => c.result.requestId === 'rename-end')?.result.status).toBe('committed');
      expect(disk.lifecycle).toBe('ended');
      sendCommand(m, a.connection, { type: 'commandStatus', requestId: 'rename-end' });
      expect(a.connection.last('error')?.code).toBe('storage-failed');
      const fresh = connect(m);
      m.handleMessage(fresh, { type: 'commandStatus', sessionId: room.sessionId, requestId: 'rename-end', token: a.joined.token });
      expect(fresh.last('error')?.code).toBe('storage-failed');
      expect(fresh.last('commandResult')).toBeUndefined();
      expect(fresh.last('joined')).toBeUndefined();
    }
    finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('out-of-turn departure does not reset the current live actor deadline', () => {
    const m = manager({ actionTimeoutMs: 30000 });
    const { a, b, room } = table(m);
    joinRoom(m, a.joined.roomCode, 'Carol');
    sendCommand(m, a.connection, { type: 'startGame' });
    vi.advanceTimersByTime(29000);
    sendCommand(m, b.connection, { type: 'leaveRoom' });
    expect(a.connection.last('stateSync')?.snapshot.actingPlayerId).toBe(a.joined.playerId);
    vi.advanceTimersByTime(1000);
    expect(a.connection.last('actionTaken')).toMatchObject({ playerId: a.joined.playerId, action: { type: 'fold' } });
    expect(room.snapshotRecord().inFlightHandId).toBeNull();
  });
  it('acknowledges departure of a mid-hand newcomer without calling the frozen engine for that identity', () => {
    const m = manager();
    const { a, b, room } = table(m);
    sendCommand(m, a.connection, { type: 'startGame' });
    const c = joinRoom(m, a.joined.roomCode, 'Carol');
    const before = b.connection.last('stateSync')?.snapshot;
    sendCommand(m, c.connection, { type: 'leaveRoom', requestId: 'waiting-leave' });
    expect(c.connection.last('commandResult')?.result).toMatchObject({ status: 'committed', requestId: 'waiting-leave' });
    expect(c.connection.last('leftIdentity')?.playerId).toBe(c.joined.playerId);
    expect(c.connection.last('error')).toBeUndefined();
    expect(room.paused).toBe(false);
    expect(room.ledgerSnapshot().rows.find(p => p.playerId === c.joined.playerId)).toMatchObject({ seatStatus: 'left', releasedChips: 5000 });
    expect(b.connection.last('stateSync')?.snapshot).toEqual(before);
  });
  it('storage failures pause the session without admitting a player or acknowledging a rebuy/end', () => {
    const store = new MemoryMatchStore<MatchRecord>();
    const m = manager({ store });
    const { a, room } = table(m);
    const revision = room.snapshotRecord().revision;
    vi.spyOn(store, 'commit').mockImplementation(() => {
      throw new Error('disk full');
    });
    sendCommand(m, a.connection, { type: 'requestEnd' });
    expect(a.connection.last('commandResult')).toBeUndefined();
    expect(a.connection.last('sessionEnded')).toBeUndefined();
    expect(room.paused).toBe(true);
    expect(room.snapshotRecord().revision).toBe(revision);
    expect(room.lifecycle).toBe('active');
  });
});
