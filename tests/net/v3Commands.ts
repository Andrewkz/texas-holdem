import { hashToken } from '../../server/src/session/MatchRecord';
import { randomBytes, randomUUID } from 'node:crypto';
import { RoomManager } from '../../server/src/RoomManager';
import type { ClientConnection } from '../../server/src/types';
import type { ClientMessage, ServerMessage } from '../../assets/scripts/net/protocol';
/** Migration helper for original rule tests: the v3 scope comes from the last authoritative server state. */
export function sendCommand(manager: RoomManager, connection: ClientConnection, message: Record<string, unknown>): void {
  const sent = (connection as {
    sent?: ServerMessage[];
  }).sent ?? [];
  const joined = Array.from(sent).reverse().find(m => m.type === 'joined') as Extract<ServerMessage, {
    type: 'joined';
  }> | undefined;
  const sync = Array.from(sent).reverse().find(m => m.type === 'stateSync') as Extract<ServerMessage, {
    type: 'stateSync';
  }> | undefined;
  let result = { ...message };
  if (message.type === 'createRoom')
    result = { requestId: randomUUID(), token: randomBytes(32).toString('hex'), ...result };
  if (message.type === 'joinRoom')
    result = { sessionId: manager.records().find(r => r.roomCode === message.roomCode && r.lifecycle !== 'ended')?.sessionId ?? 'missing', requestId: randomUUID(), token: randomBytes(32).toString('hex'), ...result };
  if (message.type === 'reconnect')
    result = { sessionId: manager.records().find(r => r.roomCode === message.roomCode)?.sessionId ?? 'missing', ...result };
  if (['startGame', 'leaveRoom', 'rebuy', 'requestEnd', 'commandStatus'].includes(message.type as string))
    result = { sessionId: joined?.sessionId ?? 'missing', requestId: randomUUID(), ...result };
  if (message.type === 'action')
    result = { sessionId: joined?.sessionId ?? 'missing', tableEpoch: sync?.tableEpoch ?? joined?.room.session.tableEpoch ?? 'missing', handId: sync?.snapshot.handId ?? 1, ...result };
  manager.handleMessage(connection, result as ClientMessage);
}
/** Construct a real conserved settled boundary instead of mutating a live seat balance. */
export function setBoundaryStacks(room: import('../../server/src/Room').Room, stacks: Record<string, number>): void {
  const internal = room as unknown as {
    transaction: (op: (record: import('../../server/src/session/MatchRecord').MatchRecord, ledger: import('../../server/src/session/SessionLedger').SessionLedger) => void) => void;
  };
  internal.transaction((r, l) => {
    const bankId = `p${r.nextPlayerNumber++}`;
    const proof = randomBytes(32).toString('hex');
    const requestId = randomUUID();
    l.addParticipant(bankId, '__boundary__', requestId);
    r.credentials.push({ playerId: bankId, tokenHash: hashToken(proof) });
    r.admissions.push({ type: 'joinRoom', playerId: bankId, nickname: '__boundary__', requestId, tokenHash: hashToken(proof) });
    const handId = r.handAttemptId + 1;
    const all = Object.fromEntries(l.toJSON().participants.filter(p => p.seatStatus === 'seated').map(p => [p.playerId, p.stack]));
    const total = Object.values(all).reduce((sum, n) => sum + n, 0);
    Object.assign(all, stacks);
    all[bankId] = total - Object.values(all).reduce((sum, n) => sum + n, 0) + all[bankId];
    l.settleHand(handId, all);
    l.requestDeparture(bankId, null);
    r.handAttemptId = handId;
    r.checkpointVersion++;
  });
}
