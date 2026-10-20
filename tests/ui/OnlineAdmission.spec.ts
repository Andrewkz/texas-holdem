import { describe, expect, it } from 'vitest';
import { acknowledgeAdmission } from '../../assets/scripts/ui/OnlineAdmission';
import { findOnlineCredentials, loadPendingAdmission, prepareAdmission, saveOnlineCredentials } from '../../assets/scripts/net/OnlineCredentials';
import type { Admission } from '../../assets/scripts/net/NetClient';
const endpoint = 'ws://localhost:3000/ws';
function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
const ended: Admission = { type: 'sessionEnded', settlement: { sessionId: 'ended-session', shareId: 'share', endedAt: 1, expiresAt: 2, reason: 'all-offline-timeout', recoveryNotice: null, rows: [] } };

describe('terminal admission acknowledgement', () => {
  it('releases a lost-joined create nonce after its ended result so the next create is fresh', () => {
    const store = storage();
    const original = prepareAdmission(store, endpoint, '甲');
    // The server committed; the joined reply was lost. Reload retries the same proof/request.
    const retry = prepareAdmission(store, endpoint, '甲');
    expect(retry.message.requestId).toBe(original.message.requestId);
    acknowledgeAdmission(store, retry, ended);
    expect(loadPendingAdmission(store, endpoint)).toBeNull();
    const next = prepareAdmission(store, endpoint, '甲');
    expect(next.message.requestId).not.toBe(original.message.requestId);
    expect(next.message.token).not.toBe(original.message.token);
  });

  it('clears an ended join attempt but keeps a replacement created by another tab', () => {
    const store = storage();
    const old = prepareAdmission(store, endpoint, '甲', { roomCode: 'ABCD', sessionId: 'ended-session' });
    acknowledgeAdmission(store, old, ended);
    expect(loadPendingAdmission(store, endpoint)).toBeNull();
    const oldAgain = prepareAdmission(store, endpoint, '甲', { roomCode: 'ABCD', sessionId: 'ended-session' });
    const newer = prepareAdmission(store, endpoint, '乙');
    acknowledgeAdmission(store, oldAgain, ended);
    expect(loadPendingAdmission(store, endpoint)?.message.requestId).toBe(newer.message.requestId);
    acknowledgeAdmission(store, newer, ended);
    expect(loadPendingAdmission(store, endpoint)).toBeNull();
  });

  it('preserves known identities and does not clear a different-session join or a proof-only restore', () => {
    const store = storage();
    const proof = { sessionId: 'ended-session', playerId: 'p1', autoResume: false, roomCode: 'ABCD', token: 'retained-proof', nickname: '甲', serverUrl: endpoint };
    saveOnlineCredentials(store, proof);
    const current = prepareAdmission(store, endpoint, '乙', { roomCode: 'WXYZ', sessionId: 'another-session' });
    acknowledgeAdmission(store, current, ended);
    acknowledgeAdmission(store, null, ended);
    expect(loadPendingAdmission(store, endpoint)?.message.requestId).toBe(current.message.requestId);
    expect(findOnlineCredentials(store, endpoint, 'ended-session')).toEqual(proof);
  });
});
