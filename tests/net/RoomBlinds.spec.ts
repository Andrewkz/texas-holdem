import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { RoomManager } from '../../server/src/RoomManager';
import { connect, joinRoom } from './fakes';
import { FileMatchStore } from '../../server/src/session/FileMatchStore';
import { validateMatchRecord, type MatchRecord } from '../../server/src/session/MatchRecord';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const managers: RoomManager[] = [];
const directories: string[] = [];
afterEach(() => { managers.splice(0).forEach(manager => manager.dispose()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); vi.useRealTimers(); });
function setup(store?: FileMatchStore<MatchRecord>) {
  const manager = new RoomManager({ store, betweenHandsMs: 5 }); managers.push(manager);
  const host = connect(manager);
  const command = { type: 'createRoom' as const, nickname: 'Alice', requestId: randomUUID(), token: randomBytes(32).toString('hex'), blinds: { smallBlind: 75, bigBlind: 150 } };
  manager.handleMessage(host, command);
  const joined = host.last('joined')!;
  return { manager, host, command, joined };
}
describe('fixed authoritative room blinds', () => {
  it('shares the chosen values with all seats and applies them to every new hand', async () => {
    vi.useFakeTimers(); const { manager, host, joined } = setup();
    expect(joined.room.blinds).toEqual({ smallBlind: 75, bigBlind: 150 });
    const guest = joinRoom(manager, joined.roomCode, 'Bob');
    expect(guest.joined.room.blinds).toEqual({ smallBlind: 75, bigBlind: 150 });
    manager.handleMessage(host, { type: 'startGame', sessionId: joined.sessionId });
    for (let hand = 1; hand <= 2; hand++) {
      const sync = host.last('stateSync')!;
      expect(sync.snapshot.handId).toBe(hand);
      expect(sync.snapshot.blinds).toEqual({ smallBlind: 75, bigBlind: 150 });
      expect(sync.snapshot.pot).toBe(225);
      expect(sync.snapshot.players.map(player => player.streetContribution).sort((a,b) => a-b)).toEqual([75,150]);
      const actor = sync.snapshot.actingPlayerId === joined.playerId ? host : guest.connection;
      manager.handleMessage(actor, { type: 'action', sessionId: joined.sessionId, tableEpoch: sync.tableEpoch, handId: hand, action: { type: 'fold' } });
      if (hand === 1) await vi.advanceTimersByTimeAsync(5);
    }
  });
  it('copies settings and binds create retries to their original configuration', () => {
    const { manager, host, command, joined } = setup();
    manager.handleMessage(host, command);
    expect(host.last('error')).toBeUndefined();
    expect(manager.records()[0].ledger.entries.filter(entry => entry.type === 'initial')).toHaveLength(1);
    command.blinds.smallBlind = 25;
    expect(manager.getRoom(joined.sessionId)!.roomState().blinds).toEqual({ smallBlind: 75, bigBlind: 150 });
    const copy = manager.getRoom(joined.sessionId)!.roomState(); copy.blinds!.bigBlind = 999;
    expect(manager.getRoom(joined.sessionId)!.roomState().blinds!.bigBlind).toBe(150);
    manager.handleMessage(host, command);
    expect(host.last('error')?.code).toBe('request-conflict');
    expect(manager.records()).toHaveLength(1);
  });
  it('restores a custom game after a real durable-store restart', () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'holdem-blinds-')); directories.push(directory);
    const store = new FileMatchStore(directory, validateMatchRecord);
    const { manager, joined, command } = setup(store);
    expect(JSON.parse(readFileSync(join(directory, `${joined.sessionId}.json`), 'utf8'))).toMatchObject({ schemaVersion: 2, blinds: { smallBlind: 75, bigBlind: 150 } });
    manager.dispose();
    const restored = new RoomManager({ store: new FileMatchStore(directory, validateMatchRecord) }); managers.push(restored);
    const host = connect(restored); restored.handleMessage(host, { type: 'reconnect', sessionId: joined.sessionId, token: command.token });
    expect(host.last('joined')!.room.blinds).toEqual({ smallBlind: 75, bigBlind: 150 });
    const guest = joinRoom(restored, joined.roomCode, 'Bob');
    restored.handleMessage(host, { type: 'startGame', sessionId: joined.sessionId });
    expect(guest.connection.last('stateSync')!.snapshot.pot).toBe(225);
  });
  it('migrates a strict v1 file to default blinds without changing revision or equity on read', () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'holdem-blinds-v1-')); directories.push(directory);
    const { manager, joined } = setup(); const legacy: any = manager.records()[0];
    legacy.schemaVersion = 1; delete legacy.blinds; manager.dispose();
    writeFileSync(join(directory, `${joined.sessionId}.json`), JSON.stringify(legacy));
    const store = new FileMatchStore(directory, validateMatchRecord); const migrated = store.loadAll()[0];
    expect(migrated).toMatchObject({ schemaVersion: 2, blinds: { smallBlind: 20, bigBlind: 40 }, revision: legacy.revision, ledger: legacy.ledger });
    expect(JSON.parse(readFileSync(join(directory, `${joined.sessionId}.json`), 'utf8'))).toEqual(legacy);
    store.commit({ ...migrated, revision: migrated.revision + 1 }, migrated.revision);
    expect(JSON.parse(readFileSync(join(directory, `${joined.sessionId}.json`), 'utf8'))).toMatchObject({ schemaVersion: 2, blinds: { smallBlind: 20, bigBlind: 40 } });
    expect(() => validateMatchRecord({ ...legacy, blinds: { smallBlind: 75, bigBlind: 150 } })).toThrow();
  });
  it.each([{ smallBlind: 0, bigBlind: 40 }, { smallBlind: 40, bigBlind: 20 }, { smallBlind: 2, bigBlind: 1001 }, { smallBlind: 1.5, bigBlind: 40 }])('rejects invalid custom values before creating a room: %j', blinds => {
    const manager = new RoomManager(); managers.push(manager); const host = connect(manager);
    manager.handleMessage(host, { type: 'createRoom', nickname: 'Alice', requestId: randomUUID(), token: randomBytes(32).toString('hex'), blinds });
    expect(host.last('error')?.code).toBe('bad-message'); expect(manager.records()).toHaveLength(0);
  });
});

it('rejects previous v3 pages before they can enter a room with the wrong default stakes', () => {
  const manager = new RoomManager(); managers.push(manager);
  const connection = { sent: [] as any[], send(message: any) { this.sent.push(message); } };
  manager.handleOpen(connection); manager.handleMessage(connection, { type: 'hello', protocolVersion: 3 });
  expect(connection.sent.at(-1)).toMatchObject({ type: 'error', code: 'protocol-mismatch' });
  expect(connection.sent.some(message => message.type === 'hello')).toBe(false);
});
