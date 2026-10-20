import { afterEach, describe, expect, it } from 'vitest';
import { RoomManager } from '../../server/src/RoomManager';
import { validateMatchRecord, hashToken } from '../../server/src/session/MatchRecord';
import { createRoom, joinRoom } from '../net/fakes';
import { sendCommand } from '../net/v3Commands';
const managers: RoomManager[] = [];
function sample(ended = false) {
  const m = new RoomManager();
  managers.push(m);
  const a = createRoom(m);
  joinRoom(m, a.joined.roomCode, 'Bob');
  if (ended)
    sendCommand(m, a.connection, { type: 'requestEnd' });
  return { record: m.records()[0], token: a.joined.token };
}
afterEach(() => managers.splice(0).forEach(m => m.dispose()));
describe('strict durable match records', () => {
  it('roundtrips an exact aggregate and stores only hashed proof', () => {
    const { record, token } = sample();
    expect(validateMatchRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(record.credentials[0].tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(record)).not.toContain(token);
    const copy = validateMatchRecord(record);
    copy.ledger.participants[0].stack = 0;
    expect(record.ledger.participants[0].stack).toBe(5000);
  });
  it.each([
    ['raw token', (r: any) => {
        r.token = 'secret';
      }], ['nested private cards', (r: any) => {
        r.ledger.participants[0].cards = [];
      }],
    ['unknown dealer', (r: any) => {r.lastDealerPlayerId='stranger';}], ['wrong checkpoint version', (r: any) => {r.checkpointVersion=9;}], ['unknown end reason', (r: any) => {r.endReason='guess';}], ['missing admission', (r: any) => {r.admissions=[];}], ['negative revision', (r: any) => {
        r.revision = -1;
      }], ['unsafe time', (r: any) => {
        r.createdAt = Number.MAX_SAFE_INTEGER + 1;
      }],
    ['seat status mismatch', (r: any) => {
        r.seatOrder = [];
      }], ['host identity', (r: any) => {
        r.hostId = 'stranger';
      }],
    ['reused player counter', (r: any) => {
        r.nextPlayerNumber = 1;
      }], ['unknown lifecycle', (r: any) => {
        r.lifecycle = 'paused';
      }],
    ['uncommitted hand mismatch', (r: any) => {
        r.inFlightHandId = 2;
      }], ['credential hash', (r: any) => {
        r.credentials[0].tokenHash = 'raw-token';
      }],
    ['duplicate proof', (r: any) => {
        r.credentials[1].tokenHash = r.credentials[0].tokenHash;
      }],
    ['admission payload mismatch', (r: any) => {
        r.admissions[0].nickname = 'Other';
      }],
    ['unknown timer identity', (r: any) => {
        r.reconnectDeadlines.stranger = 123;
      }],
    ['unknown recovery field', (r: any) => {
        r.recoveryNotice = { sessionId: r.sessionId, tableEpoch: 'e', checkpointVersion: 0, rolledBackHandId: 1, reason: 'server-restart', cards: [] };
      }],
    ['unknown recovery reason', (r: any) => {
        r.handAttemptId = 1;
        r.recoveryNotice = { sessionId: r.sessionId, tableEpoch: 'e', checkpointVersion: 0, rolledBackHandId: 1, reason: 'guess' };
      }],
  ])('rejects %s', (_name, corrupt) => {
    const { record } = sample();
    corrupt(record);
    expect(() => validateMatchRecord(record)).toThrow();
  });
  it.each([
    ['unknown command', (r: any) => {
        r.commands[0].result.command = 'action';
      }],
    ['fingerprint mismatch', (r: any) => {
        r.commands[0].fingerprint = 'different';
      }],
    ['unknown result field', (r: any) => {
        r.commands[0].result.token = 'secret';
      }],
    ['duplicate receipt', (r: any) => {
        r.commands.push(structuredClone(r.commands[0]));
      }],
    ['wrong scope', (r: any) => {
        r.commands[0].result.sessionId = 'other';
      }],
    ['unknown settlement field', (r: any) => {
        r.settlement.credentials = [];
      }],
    ['noninteger final chips', (r: any) => {
        r.settlement.rows[0].finalChips = 0.5;
      }],
    ['duplicate final identity', (r: any) => {
        r.settlement.rows[1].playerId = r.settlement.rows[0].playerId;
      }],
    ['final nickname mismatch', (r: any) => {
        r.settlement.rows[0].nickname = 'Other';
      }],
    ['final buyin mismatch', (r: any) => {
        r.settlement.rows[0].totalBuyIn = 1;
      }],
    ['final net mismatch', (r: any) => {
        r.settlement.rows[0].net = 1;
        r.settlement.rows[1].net = -1;
      }],
    ['extended expiry', (r: any) => {
        r.settlement.expiresAt++;
      }],
  ])('rejects corrupt ended record: %s', (_name, corrupt) => {
    const { record } = sample(true);
    expect(validateMatchRecord(record)).toEqual(record);
    corrupt(record);
    expect(() => validateMatchRecord(record)).toThrow();
  });
});

describe('blind configuration schema migration', () => {
  it.each([false, true])('preserves all legacy ledger and settlement fields (ended=%s)', ended => {
    const { record } = sample(ended);
    const legacy: any = structuredClone(record); legacy.schemaVersion = 1; delete legacy.blinds;
    const migrated = validateMatchRecord(legacy);
    expect(migrated).toEqual({ ...legacy, schemaVersion: 2, blinds: { smallBlind: 20, bigBlind: 40 } });
    expect(legacy).not.toHaveProperty('blinds');
    expect(validateMatchRecord(migrated)).toEqual(migrated);
  });
  it.each([
    ['missing blind config', (r: any) => { delete r.blinds; }],
    ['zero small blind', (r: any) => { r.blinds.smallBlind = 0; }],
    ['equal blind values', (r: any) => { r.blinds.smallBlind = r.blinds.bigBlind; }],
    ['oversized big blind', (r: any) => { r.blinds.bigBlind = 1001; }],
    ['fractional big blind', (r: any) => { r.blinds.bigBlind = 40.5; }],
    ['extra private nested data', (r: any) => { r.blinds.cards = []; }],
    ['unsupported schema', (r: any) => { r.schemaVersion = 3; }],
    ['legacy with custom blind extension', (r: any) => { r.schemaVersion = 1; }],
  ])('rejects corrupt blinds: %s', (_name, corrupt) => {
    const { record } = sample(); corrupt(record); expect(() => validateMatchRecord(record)).toThrow();
  });
});
