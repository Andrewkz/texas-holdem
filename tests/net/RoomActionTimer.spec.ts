import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomManager } from '../../server/src/RoomManager';
import { MemoryMatchStore } from '../../server/src/session/MemoryMatchStore';
import { MatchRecord } from '../../server/src/session/MatchRecord';
import { connect, createRoom, joinRoom } from './fakes';
import { sendCommand } from './v3Commands';

function table(count = 2, store?: MemoryMatchStore<MatchRecord>) {
  const manager = new RoomManager({ actionTimeoutMs: 30000, betweenHandsMs: 60000, store });
  const a = createRoom(manager);
  const b = joinRoom(manager, a.joined.roomCode, 'Bob');
  const c = count === 3 ? joinRoom(manager, a.joined.roomCode, 'Carol') : null;
  sendCommand(manager, a.connection, { type: 'startGame' });
  return { manager, a, b, c, room: manager.getRoom(a.joined.sessionId)! };
}

describe('authoritative turn timer', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); });
  afterEach(() => { vi.useRealTimers(); });

  it('includes the actual initial deadline in the first recipient snapshots', () => {
    const { a, b, c } = table(3);
    for (const peer of [a, b, c!]) {
      expect(peer.connection.last('stateSync')?.turnTimer).toEqual({
        playerId: a.joined.playerId, deadlineAt: 130000, serverNow: 100000, durationMs: 30000,
      });
    }
  });

  it('starts a fresh deadline before broadcasting the next actor', () => {
    const { manager, a, b } = table(3);
    vi.advanceTimersByTime(5000);
    sendCommand(manager, a.connection, { type: 'action', action: { type: 'fold' } });
    expect(b.connection.last('stateSync')?.turnTimer).toEqual({
      playerId: b.joined.playerId, deadlineAt: 135000, serverNow: 105000, durationMs: 30000,
    });
  });

  it('renews a same-player turn when checking advances to the next street', () => {
    const { manager, a, b } = table();
    vi.advanceTimersByTime(1000);
    sendCommand(manager, a.connection, { type: 'action', action: { type: 'call', amount: 20 } });
    expect(b.connection.last('stateSync')?.turnTimer?.deadlineAt).toBe(131000);
    vi.advanceTimersByTime(2000);
    sendCommand(manager, b.connection, { type: 'action', action: { type: 'check' } });
    expect(b.connection.last('stateSync')?.snapshot).toMatchObject({ street: 'flop', actingPlayerId: b.joined.playerId });
    expect(b.connection.last('stateSync')?.turnTimer).toEqual({
      playerId: b.joined.playerId, deadlineAt: 133000, serverNow: 103000, durationMs: 30000,
    });
    vi.advanceTimersByTime(29999);
    expect(a.connection.last('actionTaken')?.action).toEqual({ type: 'check' });
    expect(a.connection.last('actionTaken')?.playerId).toBe(b.joined.playerId);
    vi.advanceTimersByTime(1);
    expect(a.connection.sent.filter(message => message.type === 'actionTaken' && message.playerId === b.joined.playerId)).toHaveLength(2);
    expect(a.connection.last('stateSync')?.turnTimer?.playerId).toBe(a.joined.playerId);
  });

  it('reconnects at 29 seconds with the original deadline and actually folds at expiry', () => {
    const { manager, a, room } = table();
    vi.advanceTimersByTime(29000);
    manager.handleClose(a.connection);
    const back = connect(manager);
    manager.handleMessage(back, { type: 'reconnect', sessionId: room.sessionId, token: a.joined.token });
    expect(back.last('stateSync')?.turnTimer).toEqual({
      playerId: a.joined.playerId, deadlineAt: 130000, serverNow: 129000, durationMs: 30000,
    });
    vi.advanceTimersByTime(999);
    expect(back.last('actionTaken')).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(back.last('actionTaken')).toMatchObject({ playerId: a.joined.playerId, action: { type: 'fold' } });
    expect(back.last('stateSync')?.turnTimer).toBeNull();
  });

  it('does not postpone the live actor when another player departs at 29 seconds', () => {
    const { manager, a, b } = table(3);
    vi.advanceTimersByTime(29000);
    sendCommand(manager, b.connection, { type: 'leaveRoom' });
    expect(a.connection.last('stateSync')?.turnTimer).toEqual({
      playerId: a.joined.playerId, deadlineAt: 130000, serverNow: 129000, durationMs: 30000,
    });
    vi.advanceTimersByTime(1000);
    expect(a.connection.last('actionTaken')).toMatchObject({ playerId: a.joined.playerId, action: { type: 'fold' } });
    expect(a.connection.last('stateSync')?.turnTimer).toBeNull();
  });

  it('keeps the existing timeout rule while every connection is offline', () => {
    const { manager, a, b, room } = table();
    manager.handleClose(a.connection);
    manager.handleClose(b.connection);
    vi.advanceTimersByTime(30000);
    expect(room.snapshotRecord().ledger.committedHandId).toBe(1);
    expect(room.snapshotRecord().inFlightHandId).toBeNull();
    const back = connect(manager);
    manager.handleMessage(back, { type: 'reconnect', sessionId: room.sessionId, token: a.joined.token });
    expect(back.last('stateSync')?.turnTimer).toBeNull();
  });

  it('clears the clock after storage failure and never executes its old timeout', () => {
    class FailingStore extends MemoryMatchStore<MatchRecord> {
      fail = false;
      override commit(next: MatchRecord, expectedRevision: number): void {
        if (this.fail) throw new Error('disk unavailable');
        super.commit(next, expectedRevision);
      }
    }
    const store = new FailingStore();
    const { manager, a, room } = table(2, store);
    store.fail = true;
    sendCommand(manager, a.connection, { type: 'requestEnd' });
    expect(a.connection.last('error')?.code).toBe('storage-failed');
    room.resendHandState(room.identify(a.joined.token)!);
    expect(a.connection.last('stateSync')?.turnTimer).toBeNull();
    vi.advanceTimersByTime(60000);
    expect(a.connection.last('actionTaken')).toBeUndefined();
    expect(room.snapshotRecord().inFlightHandId).toBe(1);
  });
});
