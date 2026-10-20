/** Real process fixture. Only the parent test can arm the injected synchronous disk barrier. */
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { FileMatchStore } from '../../../server/src/session/FileMatchStore';
import { validateMatchRecord, type MatchRecord } from '../../../server/src/session/MatchRecord';
import { RoomManager } from '../../../server/src/RoomManager';
import { createWsServer } from '../../../server/src/server';

let fixedNow = process.env.CRASH_NOW ? Number(process.env.CRASH_NOW) : null;
const actualNow = Date.now.bind(Date);
Date.now = () => fixedNow ?? actualNow();
let armed: { point: string; operation: string; requestId?: string } | null = null;
function matches(record: MatchRecord): boolean {
  if (!armed) return false;
  switch (armed.operation) {
    case 'checkpoint': return record.ledger.committedHandId === 1 && record.inFlightHandId === null;
    case 'rebuy': return record.ledger.participants.some(p => p.playerId === 'p1' && p.rebuyCount === 1);
    default: return record.commands.some(c => c.result.requestId === armed!.requestId);
  }
}
const store = new FileMatchStore<MatchRecord>(process.env.CRASH_DATA!, validateMatchRecord, {
  at(point, record) {
    if (armed?.point !== point || !matches(record)) return;
    // Sibling marker survives a blocked event loop and cannot be mistaken for a committed record.
    writeFileSync(process.env.CRASH_MARKER!, JSON.stringify({ pid: process.pid, point, operation: armed.operation, candidate: record }));
    process.send?.({ type: 'barrier', pid: process.pid, point });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error('Barrier must only be released by SIGKILL');
  },
});
const manager = new RoomManager({ store, actionTimeoutMs: Number(process.env.CRASH_ACTION ?? 600_000), betweenHandsMs: Number(process.env.CRASH_BETWEEN ?? 600_000) });
const server = createWsServer(manager, Number(process.env.CRASH_PORT ?? 0), 0, '127.0.0.1');
process.on('message', (m: any) => {
  if (m.type === 'arm') armed = m.barrier;
  if (m.type === 'now') fixedNow = m.now;
  process.send?.({ type: 'response', id: m.id, records: manager.records() });
});
server.httpServer.once('listening', () => process.send?.({ type: 'ready', pid: process.pid, port: (server.httpServer.address() as AddressInfo).port, records: manager.records() }));
