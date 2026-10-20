import { PROTOCOL_VERSION } from '../../assets/scripts/net/protocol';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { FileMatchStore } from '../../server/src/session/FileMatchStore';
import { hashToken, validateMatchRecord, type MatchRecord } from '../../server/src/session/MatchRecord';
import { SessionLedger } from '../../server/src/session/SessionLedger';
import type { CommitPoint } from '../../server/src/session/MatchStore';

const points: CommitPoint[] = ['before-write', 'after-file-sync', 'after-rename', 'after-directory-sync'];
const evidence: unknown[] = [];
const evidencePath = '/tmp/session-lifecycle-crash-evidence.json';
const children = new Set<Service>();
const directories: string[] = [];
const sockets = new Set<Client>();
const pause = (ms = 10) => new Promise(r => setTimeout(r, ms));
async function until<T>(read: () => T | undefined | false, label: string, limit = 10000): Promise<T> {
  const end = Date.now() + limit;
  while (Date.now() < end) { const value = read(); if (value) return value; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
function directory(): string { const d = mkdtempSync(join(realpathSync(tmpdir()), 'poker-crash-')); directories.push(d); return d; }
function rows(r: MatchRecord) { return r.ledger.participants; }
function receipt(r: MatchRecord, id: string) { return r.commands.find(c => c.result.requestId === id)?.result; }
class Service {
  child: ChildProcess;
  messages: any[] = [];
  terminal: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  port = 0;
  pid = 0;
  errors = '';
  constructor(public root: string, now?: number, between?: number) {
    this.child = spawn(process.execPath, ['--import', resolve('server/node_modules/tsx/dist/loader.mjs'), resolve('tests/session/fixtures/child-server.ts')], {
      cwd: resolve('.'), env: { ...process.env, CRASH_DATA: join(root, 'data'), CRASH_MARKER: join(root, 'barrier'), ...(now === undefined ? {} : { CRASH_NOW: String(now) }), ...(between === undefined ? {} : { CRASH_BETWEEN: String(between) }) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child.on('message', m => this.messages.push(m));
    this.child.stderr!.on('data', d => this.errors += d.toString());
    this.terminal = new Promise(res => this.child.once('exit', (code, signal) => res({ code, signal })));
    children.add(this);
  }
  static async start(root = directory(), now?: number, between?: number) {
    const s = new Service(root, now, between);
    const m = await until(() => s.messages.find(m => m.type === 'ready'), `service ready ${s.errors}`);
    s.port = m.port; s.pid = m.pid; expect(s.child.pid).toBe(s.pid); return s;
  }
  async rpc(type: string, payload: object = {}): Promise<MatchRecord[]> {
    const id = randomUUID(); this.child.send({ type, id, ...payload });
    return (await until(() => this.messages.find(m => m.id === id), `IPC ${type}: ${this.errors}`)).records;
  }
  async record() { return (await this.rpc('records'))[0]; }
  async arm(point: CommitPoint, operation: string, requestId?: string) { await this.rpc('arm', { barrier: { point, operation, requestId } }); }
  async kill() {
    this.child.kill('SIGKILL'); const result = await this.terminal;
    children.delete(this); expect(result).toEqual({ code: null, signal: 'SIGKILL' }); return result;
  }
  async barrier(before: MatchRecord, operation: string, point: CommitPoint) {
    const marker = await until(() => existsSync(join(this.root, 'barrier')) && JSON.parse(readFileSync(join(this.root, 'barrier'), 'utf8')), `${operation}/${point} barrier ${this.errors}`);
    expect(marker.pid).toBe(this.pid); expect(marker.point).toBe(point);
    const exit = await this.kill();
    const disk = validateMatchRecord(JSON.parse(readFileSync(join(this.root, 'data', `${before.sessionId}.json`), 'utf8')));
    const committed = point === 'after-rename' || point === 'after-directory-sync';
    expect(marker.candidate.revision).toBe(before.revision + 1);
    expect(disk).toEqual(committed ? marker.candidate : before);
    const entry: any = { operation, point, pid: this.pid, exit, preRevision: before.revision, attemptedRevision: marker.candidate.revision, durableRevision: disk.revision, before, attemptedCandidate: marker.candidate, durable: disk };
    evidence.push(entry); return { disk, committed, entry, candidate: marker.candidate as MatchRecord };
  }
}
class Client {
  messages: any[] = [];
  constructor(public ws: WebSocket) { sockets.add(this); ws.on('message', d => this.messages.push(JSON.parse(d.toString()))); ws.on('error', () => {}); }
  static async connect(s: Service) {
    const c = new Client(new WebSocket(`ws://127.0.0.1:${s.port}/ws`));
    await new Promise<void>((res, rej) => { c.ws.once('open', res); c.ws.once('error', rej); });
    c.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION }); await c.wait(m => m.type === 'hello'); return c;
  }
  send(m: object) { this.ws.send(JSON.stringify(m)); }
  wait(predicate: (m: any) => boolean) { return until(() => this.messages.find(predicate), `WS message; received ${JSON.stringify(this.messages.slice(-3))}`); }
  latest(type: string) { return [...this.messages].reverse().find(m => m.type === type); }
  async command(type: string, sessionId: string, requestId: string) {
    this.send({ type, sessionId, requestId }); return this.wait(m => m.type === 'commandResult' && m.result.requestId === requestId);
  }
  async close() { this.ws.terminate(); sockets.delete(this); }
}
const tokens = ['a'.repeat(64), 'b'.repeat(64)];
async function table(s: Service) {
  const a = await Client.connect(s), b = await Client.connect(s);
  a.send({ type: 'createRoom', nickname: 'Alice', requestId: 'create-a', token: tokens[0] });
  const joined = await a.wait(m => m.type === 'joined');
  b.send({ type: 'lookupRoom', roomCode: joined.roomCode });
  expect(await b.wait(m => m.type === 'roomLookup')).toMatchObject({ sessionId: joined.sessionId });
  b.send({ type: 'joinRoom', sessionId: joined.sessionId, roomCode: joined.roomCode, nickname: 'Bob', requestId: 'join-b', token: tokens[1] });
  await b.wait(m => m.type === 'joined'); return { a, b, id: joined.sessionId };
}
async function reconnect(s: Service, id: string, index: number) {
  const c = await Client.connect(s); c.send({ type: 'reconnect', sessionId: id, token: tokens[index] });
  await c.wait(m => m.type === 'joined' || m.type === 'sessionEnded' || m.type === 'error'); return c;
}
async function status(s: Service, id: string, index: number, requestId: string) {
  const c = await Client.connect(s); c.send({ type: 'commandStatus', sessionId: id, token: tokens[index], requestId });
  return { c, response: await c.wait(m => m.type === 'commandResult' || m.type === 'error') };
}
async function start(a: Client, id: string, hand = 1) {
  a.send({ type: 'startGame', sessionId: id });
  return a.wait(m => m.type === 'stateSync' && m.snapshot.handId === hand && m.snapshot.street === 'preflop');
}
async function act(a: Client, b: Client, id: string, type?: string) {
  const sync = a.latest('stateSync'), actor = sync.snapshot.actingPlayerId === 'p1' ? a : b;
  const actorSync = await actor.wait(m => m.type === 'stateSync' && m.snapshot.handId === sync.snapshot.handId && m.snapshot.street === sync.snapshot.street && m.snapshot.actingPlayerId === sync.snapshot.actingPlayerId && m.snapshot.legalActions.length > 0);
  const action = type ? actorSync.snapshot.legalActions.find((x: any) => x.type === type) : actorSync.snapshot.legalActions.find((x: any) => x.type === 'check') ?? actorSync.snapshot.legalActions.find((x: any) => x.type === 'call');
  expect(action).toBeDefined(); const count = a.messages.length;
  actor.send({ type: 'action', sessionId: id, tableEpoch: sync.tableEpoch, handId: sync.snapshot.handId, action });
  return { count };
}
function seedBusted(root: string) {
  const id = randomUUID(), ledger = SessionLedger.create(id);
  ledger.addParticipant('p1', 'Alice', 'create-a'); ledger.addParticipant('p2', 'Bob', 'join-b'); ledger.settleHand(1, { p1: 0, p2: 10000 });
  const record: MatchRecord = { schemaVersion: 1, sessionId: id, revision: 1, roomCode: 'AB23', createdAt: Date.now(), ledger: ledger.toJSON(), credentials: tokens.map((t, i) => ({ playerId: `p${i + 1}`, tokenHash: hashToken(t) })), admissions: tokens.map((t, i) => ({ requestId: i ? 'join-b' : 'create-a', type: i ? 'joinRoom' : 'createRoom', nickname: i ? 'Bob' : 'Alice', tokenHash: hashToken(t), playerId: `p${i + 1}` })), commands: [], seatOrder: ['p1', 'p2'], hostId: 'p1', nextPlayerNumber: 3, lastDealerPlayerId: 'p1', lastDealerSeatIndex: 0, handAttemptId: 1, checkpointVersion: 1, inFlightHandId: null, lifecycle: 'active', endReason: null, reconnectDeadlines: {}, allOfflineDeadline: null, recoveryNotice: null, settlement: null };
  new FileMatchStore<MatchRecord>(join(root, 'data'), validateMatchRecord).commit(record, 0); return record;
}
afterEach(async () => {
  for (const c of sockets) await c.close();
  for (const s of [...children]) await s.kill();
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
  writeFileSync(evidencePath, JSON.stringify({ generatedAt: new Date().toISOString(), cases: evidence }, null, 2));
});
afterAll(() => expect(children.size).toBe(0));

describe('independent service process SIGKILL durability', () => {
  it.each(points)('complete-hand checkpoint at %s restores exactly one old or new conserved ledger', async point => {
    const s = await Service.start(), { a, b, id } = await table(s); await start(a, id);
    const before = await s.record(); await s.arm(point, 'checkpoint'); await act(a, b, id, 'fold');
    const result = await s.barrier(before, 'checkpoint', point);
    const restored = await Service.start(s.root), r = await restored.record();
    expect(r.ledger).toEqual(result.disk.ledger); expect(r.credentials).toEqual(before.credentials); expect(r.admissions).toEqual(before.admissions);
    expect(r.ledger.committedHandId).toBe(result.committed ? 1 : 0);
    expect(rows(r).map(p => p.stack)).toEqual(result.committed ? [4980, 5020] : [5000, 5000]);
    expect(r.inFlightHandId).toBeNull(); expect(r.checkpointVersion).toBe(result.committed ? 1 : 0);
    expect(r.lastDealerPlayerId).toBe(result.committed ? 'p1' : null); expect(r.lastDealerSeatIndex).toBe(result.committed ? 0 : -1);
    expect(r.seatOrder).toEqual(result.disk.seatOrder); expect(r.commands).toEqual(result.disk.commands);
    expect(r.handAttemptId).toBe(1); expect(r.recoveryNotice?.rolledBackHandId ?? null).toBe(result.committed ? null : 1);
    const back = await reconnect(restored, id, 0); expect(back.messages.some(m => m.type === 'yourHand')).toBe(false);
    result.entry.restored = r;
  }, 25000);

  it.each(points)('queued rebuy prehand at %s applies once across restart, query and retry', async point => {
    const root = directory(), seed = seedBusted(root), s = await Service.start(root);
    const a = await reconnect(s, seed.sessionId, 0), b = await reconnect(s, seed.sessionId, 1);
    expect((await a.command('rebuy', seed.sessionId, 'rebuy-a')).result.status).toBe('pending');
    const before = await s.record(); expect(rows(before)[0]).toMatchObject({ stack: 0, totalBuyIn: 5000, pendingRebuyRequestId: 'rebuy-a' });
    await s.arm(point, 'rebuy'); a.send({ type: 'startGame', sessionId: seed.sessionId });
    const result = await s.barrier(before, 'rebuy', point), restored = await Service.start(root), r = await restored.record();
    expect(r.ledger).toEqual(result.disk.ledger); expect(r.handAttemptId).toBe(result.committed ? 2 : 1); expect(r.checkpointVersion).toBe(1);
    expect(r.lastDealerPlayerId).toBe(seed.lastDealerPlayerId); expect(r.commands).toEqual(result.disk.commands); expect(rows(r)[0]).toMatchObject(result.committed ? { stack: 5000, totalBuyIn: 10000, rebuyCount: 1, pendingRebuyRequestId: null } : { stack: 0, totalBuyIn: 5000, rebuyCount: 0, pendingRebuyRequestId: 'rebuy-a' });
    const query = await status(restored, seed.sessionId, 0, 'rebuy-a');
    expect(query.response.result.status).toBe(result.committed ? 'committed' : 'pending');
    expect((await restored.record()).seatOrder).toEqual(r.seatOrder); // proof query never claims a seat
    const again = await reconnect(restored, seed.sessionId, 0); await reconnect(restored, seed.sessionId, 1);
    expect((await again.command('rebuy', seed.sessionId, 'rebuy-a')).result.status).toBe(result.committed ? 'committed' : 'pending');
    if (!result.committed) await start(again, seed.sessionId, 2);
    const final = await restored.record(); expect(rows(final)[0]).toMatchObject({ stack: 5000, totalBuyIn: 10000, rebuyCount: 1 });
    expect(final.ledger.entries.filter(e => e.type === 'rebuy')).toHaveLength(1); expect(receipt(final, 'rebuy-a')?.status).toBe('committed');
    result.entry.restored = r; result.entry.afterRetry = final;
  }, 25000);

  for (const operation of ['leaveRoom', 'rejoin'] as const) it.each(points)(`${operation} ownership at %s is whole and original proof queries without seat claim`, async point => {
    const s = await Service.start(), { a, b, id } = await table(s);
    if (operation === 'rejoin') expect((await b.command('leaveRoom', id, 'leave-before-rejoin')).result.status).toBe('committed');
    const before = await s.record(), requestId = `${operation}-b`; await s.arm(point, operation, requestId);
    if (operation === 'rejoin') b.send({ type: 'rejoin', sessionId: id, token: tokens[1], requestId });
    else b.send({ type: operation, sessionId: id, requestId });
    const result = await s.barrier(before, operation, point), restored = await Service.start(s.root), r = await restored.record();
    expect(r.ledger).toEqual(result.disk.ledger); expect(r.commands).toEqual(result.disk.commands);
    expect(r.seatOrder).toEqual(result.disk.seatOrder); expect(r.credentials).toEqual(before.credentials); expect(r.admissions).toEqual(before.admissions);
    const left = operation === 'leaveRoom' ? result.committed : !result.committed;
    expect(rows(r)[1]).toMatchObject({ stack: left ? 0 : 5000, releasedChips: left ? 5000 : 0, seatStatus: left ? 'left' : 'seated', totalBuyIn: 5000 });
    const unchanged = await restored.record(), query = await status(restored, id, 1, requestId);
    expect(query.response).toMatchObject(result.committed ? { type: 'commandResult', result: { status: 'committed', requestId } } : { type: 'error', code: 'command-not-found' });
    expect(await restored.record()).toEqual(unchanged);
    if (left) {
      const c = await Client.connect(restored); c.send({ type: 'rejoin', sessionId: id, token: tokens[1], requestId: operation === 'rejoin' ? requestId : 'return-b' });
      await c.wait(m => m.type === 'joined');
    }
    if (operation === 'rejoin') {
      // A fresh connection retries the exact lost acknowledgement, using the original identity.
      const retry = await Client.connect(restored);
      retry.send({ type: 'rejoin', sessionId: id, token: tokens[1], requestId });
      expect((await retry.wait(m => m.type === 'commandResult')).result).toMatchObject({ status: 'committed', requestId });
      expect(await retry.wait(m => m.type === 'joined')).toMatchObject({ playerId: 'p2' });
    }
    const final = await restored.record(); expect(rows(final)[1]).toMatchObject({ stack: 5000, releasedChips: 0, seatStatus: 'seated', totalBuyIn: 5000 });
    expect(final.ledger.entries.filter(e => e.type === 'rejoin' && e.playerId === 'p2')).toHaveLength(operation === 'rejoin' || (operation === 'leaveRoom' && result.committed) ? 1 : 0);
    result.entry.restored = r; result.entry.afterRetry = final;
  }, 25000);

  it.each(points)('end at %s retains fixed final snapshot, receipt and 30 day expiry', async point => {
    const s = await Service.start(), { a, id } = await table(s), before = await s.record();
    await s.arm(point, 'requestEnd', 'end-a'); a.send({ type: 'requestEnd', sessionId: id, requestId: 'end-a' });
    const result = await s.barrier(before, 'requestEnd', point), restored = await Service.start(s.root); let r = await restored.record();
    expect(r.ledger).toEqual(result.disk.ledger);
    if (result.committed) { expect(r).toEqual(result.candidate); expect(r.settlement).toEqual(result.candidate.settlement); }
    else { expect(r.settlement).toBeNull(); const c = await reconnect(restored, id, 0); await c.command('requestEnd', id, 'end-a'); r = await restored.record(); }
    const fixed = r.settlement!; expect(fixed.expiresAt - fixed.endedAt).toBe(30 * 86400000); expect(fixed.rows.map(p => p.net)).toEqual([0, 0]);
    const beforeQuery = await restored.record();
    for (let i = 0; i < 2; i++) {
      const q = await status(restored, id, 0, 'end-a'); expect(q.response.result.status).toBe('committed');
      const c = await reconnect(restored, id, 0); expect(c.latest('sessionEnded').settlement).toEqual(fixed);
    }
    expect(await restored.record()).toEqual(beforeQuery); await restored.kill();
    const second = await Service.start(s.root); expect((await second.record()).settlement).toEqual(fixed);
    result.entry.restored = r; result.entry.fixedSettlement = fixed;
  }, 25000);
});

describe('real service restart lifecycle and unfinished-hand rollback', () => {
  it.each(['preflop', 'flop', 'turn', 'river'])('second hand killed at %s rolls back only that hand and preserves confirmed join', async street => {
    const s = await Service.start(undefined, undefined, 60), { a, b, id } = await table(s);
    await start(a, id); await act(a, b, id, 'fold');
    await a.wait(m => m.type === 'stateSync' && m.snapshot.handId === 2 && m.snapshot.street === 'preflop');
    while (a.latest('stateSync').snapshot.street !== street) {
      const { count } = await act(a, b, id);
      await until(() => a.messages.slice(count).find(m => m.type === 'stateSync'), 'next real action state');
    }
    const joiner = await Client.connect(s), token = randomBytes(32).toString('hex');
    joiner.send({ type: 'joinRoom', sessionId: id, roomCode: a.latest('joined').roomCode, nickname: 'Carol', requestId: 'join-during-hand2', token });
    await joiner.wait(m => m.type === 'joined');
    const before = await s.record(), epoch = a.latest('stateSync').tableEpoch;
    expect(before.ledger.committedHandId).toBe(1); expect(before.inFlightHandId).toBe(2);
    const exit = await s.kill(), restored = await Service.start(s.root), r = await restored.record();
    expect(r.ledger).toEqual(before.ledger); expect(r.admissions).toEqual(before.admissions); expect(r.credentials).toEqual(before.credentials);
    expect(rows(r).map(p => p.stack)).toEqual([4980, 5020, 5000]);
    expect(r.handAttemptId).toBe(2); expect(r.checkpointVersion).toBe(1); expect(r.inFlightHandId).toBeNull();
    expect(r.recoveryNotice).toMatchObject({ rolledBackHandId: 2, checkpointVersion: 1, reason: 'server-restart' });
    expect(r.recoveryNotice!.tableEpoch).not.toBe(epoch);
    const back = await reconnect(restored, id, 0); expect(back.messages.some(m => ['yourHand', 'handStart', 'stateSync'].includes(m.type))).toBe(false);
    expect(await back.wait(m => m.type === 'recoveryNotice')).toMatchObject({ notice: { rolledBackHandId: 2 } });
    back.send({ type: 'action', sessionId: id, tableEpoch: epoch, handId: 2, action: { type: 'fold' } });
    expect(await back.wait(m => m.type === 'error')).toMatchObject({ code: 'stale-action' });
    evidence.push({ operation: 'unfinished-second-hand', street, pid: s.pid, exit, preRevision: before.revision, preLedger: before.ledger, restored: r });
  }, 25000);

  it('confirmed pending departure survives kill as exclusive released checkpoint ownership and a query never rejoins it', async () => {
    const s = await Service.start(), { a, b, id } = await table(s);
    const c = await Client.connect(s), token = randomBytes(32).toString('hex');
    c.send({ type: 'joinRoom', sessionId: id, roomCode: a.latest('joined').roomCode, nickname: 'Carol', requestId: 'join-c-before-hand', token });
    expect(await c.wait(m => m.type === 'joined')).toMatchObject({ playerId: 'p3' });
    await start(a, id);
    await c.wait(m => m.type === 'yourHand'); // All three original seats hold this hand's live equity.
    expect((await a.command('leaveRoom', id, 'leave-in-flight')).result.status).toBe('committed');
    const before = await s.record();
    expect(before.inFlightHandId).toBe(1); expect(before.ledger.committedHandId).toBe(0); expect(before.checkpointVersion).toBe(0);
    expect(rows(before)[0]).toMatchObject({ seatStatus: 'leaving-hand', stack: 5000, releasedChips: 0, pendingDepartureHandId: 1 });
    expect(b.latest('stateSync').snapshot.street).not.toBe('settled');
    const exit = await s.kill(), restored = await Service.start(s.root), r = await restored.record();
    expect(rows(r)[0]).toMatchObject({ seatStatus: 'left', stack: 0, releasedChips: 5000, pendingDepartureHandId: null });
    expect(rows(r).slice(1)).toMatchObject([{ playerId: 'p2', stack: 5000, releasedChips: 0 }, { playerId: 'p3', stack: 5000, releasedChips: 0 }]);
    expect(rows(r).reduce((sum, p) => sum + p.stack + p.releasedChips, 0)).toBe(15000);
    expect(r.ledger.committedHandId).toBe(0); expect(r.checkpointVersion).toBe(0); expect(r.inFlightHandId).toBeNull();
    expect(r.recoveryNotice).toMatchObject({ rolledBackHandId: 1, reason: 'server-restart' });
    expect(r.credentials).toEqual(before.credentials); expect(r.admissions).toEqual(before.admissions);
    expect(r.seatOrder).toEqual(['p2', 'p3']); expect(receipt(r, 'leave-in-flight')).toEqual(receipt(before, 'leave-in-flight'));
    const unchanged = await restored.record(), q = await status(restored, id, 0, 'leave-in-flight'); expect(q.response.result.status).toBe('committed');
    expect(await restored.record()).toEqual(unchanged);
    evidence.push({ operation: 'pending-departure-rollback', pid: s.pid, exit, before, restored: r });
  }, 25000);

  it('confirmed end intent during unfinished hand is retained and fixes one rollback settlement after restart', async () => {
    const s = await Service.start(), { a, id } = await table(s); await start(a, id);
    expect((await a.command('requestEnd', id, 'end-after-current')).result.status).toBe('committed');
    const before = await s.record(); expect(before.lifecycle).toBe('ending-after-hand'); expect(before.settlement).toBeNull();
    const exit = await s.kill(), restored = await Service.start(s.root), r = await restored.record();
    expect(r.lifecycle).toBe('ended'); expect(r.settlement?.rows.map(p => p.finalChips)).toEqual([5000, 5000]);
    expect(r.recoveryNotice?.rolledBackHandId).toBe(1); expect(receipt(r, 'end-after-current')).toEqual(receipt(before, 'end-after-current'));
    const q = await status(restored, id, 0, 'end-after-current'); expect(q.response.result.status).toBe('committed');
    await restored.kill(); const again = await Service.start(s.root); expect(await again.record()).toEqual(r);
    evidence.push({ operation: 'end-intent-rollback', pid: s.pid, exit, before, restored: r });
  }, 25000);

  it('persisted absolute 180 second all-offline deadline survives repeated real kills and ends at the exact original boundary', async () => {
    const now = 2_000_000_000_000, s = await Service.start(undefined, now), { a, b, id } = await table(s); await start(a, id);
    await a.close(); await b.close();
    const before = await until(() => {
      const path = join(s.root, 'data', `${id}.json`), r = validateMatchRecord(JSON.parse(readFileSync(path, 'utf8')));
      return r.allOfflineDeadline === now + 180000 && r;
    }, 'last offline persisted deadline');
    expect(before.lifecycle).toBe('all-offline-wait');
    const exit = await s.kill(), restored = await Service.start(s.root, now + 179999), waiting = await restored.record();
    expect(waiting.lifecycle).toBe('all-offline-wait'); expect(waiting.allOfflineDeadline).toBe(now + 180000);
    expect(waiting.ledger).toEqual(before.ledger); expect(waiting.inFlightHandId).toBeNull();
    await restored.kill(); const expired = await Service.start(s.root, now + 180000), final = await expired.record();
    expect(final.lifecycle).toBe('ended'); expect(final.settlement).toMatchObject({ endedAt: now + 180000, reason: 'all-offline-timeout' });
    expect(final.settlement!.rows.map(p => p.finalChips)).toEqual([5000, 5000]); expect(final.settlement!.rows.reduce((n, p) => n + p.net, 0)).toBe(0);
    const back = await reconnect(expired, id, 0); expect(back.latest('sessionEnded').settlement).toEqual(final.settlement);
    expect(await expired.record()).toEqual(final);
    evidence.push({ operation: 'absolute-offline-deadline', pid: s.pid, exit, originalDeadline: before.allOfflineDeadline, before, waiting, restored: final });
  }, 25000);
});
