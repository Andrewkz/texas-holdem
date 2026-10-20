import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomManager } from '../../server/src/RoomManager';
import { createWsServer } from '../../server/src/server';
import { MemoryMatchStore } from '../../server/src/session/MemoryMatchStore';
import type { MatchRecord } from '../../server/src/session/MatchRecord';
import { createRoom, joinRoom } from '../net/fakes';
import { sendCommand } from '../net/v3Commands';
const servers: ReturnType<typeof createWsServer>[] = [];
const managers: RoomManager[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) {
    for (const c of s.clients)
      c.terminate();
    await new Promise<void>(resolve => s.close(() => resolve()));
  }
  for (const m of managers.splice(0))
    m.dispose();
});
async function listen(m: RoomManager) {
  const server = createWsServer(m, 0, 0, '127.0.0.1');
  servers.push(server);
  managers.push(m);
  await new Promise<void>(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
describe('immutable public settlement HTTP', () => {
  it('serves only explicit public fields with no-store and exact 30-day expiry; access never extends it', async () => {
    const store = new MemoryMatchStore<MatchRecord>();
    const manager = new RoomManager({ store });
    const a = createRoom(manager, '<img src=x>');
    const b = joinRoom(manager, a.joined.roomCode, 'Bob');
    sendCommand(manager, b.connection, { type: 'leaveRoom' });
    sendCommand(manager, a.connection, { type: 'requestEnd' });
    const record = manager.records()[0];
    const settlement = record.settlement!;
    const base = await listen(manager);
    const url = `${base}/api/settlements/${settlement.shareId}`;
    const time = vi.spyOn(Date, 'now').mockReturnValue(settlement.expiresAt - 1);
    const first = await fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const body = await first.json();
    expect(body).toEqual(settlement);
    expect(Object.keys(body).sort()).toEqual(['sessionId', 'shareId', 'endedAt', 'expiresAt', 'reason', 'recoveryNotice', 'rows'].sort());
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].nickname).toBe('<img src=x>');
    const text = JSON.stringify(body);
    for (const secret of [a.joined.token, b.joined.token, record.credentials[0].tokenHash, 'credentials', 'admissions', 'commands', 'cards'])
      expect(text).not.toContain(secret);
    const revision = manager.records()[0].revision;
    expect((await fetch(url)).status).toBe(200);
    expect(manager.records()[0].revision).toBe(revision);
    time.mockReturnValue(settlement.expiresAt);
    const expired = await fetch(url);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: 'expired' });
    expect(expired.headers.get('cache-control')).toBe('no-store');
    expect(manager.records()[0].settlement?.expiresAt).toBe(settlement.expiresAt);
    expect((await fetch(`${base}/api/settlements/unknown`)).status).toBe(404);
    expect((await fetch(url, { method: 'POST' })).status).toBe(404);
  });
  it('restores the exact immutable final result and expiry after restart', async () => {
    const store = new MemoryMatchStore<MatchRecord>();
    const old = new RoomManager({ store });
    const a = createRoom(old);
    sendCommand(old, a.connection, { type: 'requestEnd' });
    const before = old.records()[0];
    old.dispose();
    const restored = new RoomManager({ store });
    const base = await listen(restored);
    expect(restored.records()[0]).toEqual(before);
    const result = await fetch(`${base}/api/settlements/${before.settlement!.shareId}`);
    expect(await result.json()).toEqual(before.settlement);
  });
});
