import { PROTOCOL_VERSION } from '../../assets/scripts/net/protocol';
import { sendCommand } from './v3Commands';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RoomManager } from '../../server/src/RoomManager';
import { FakeConnection, connect, createRoom, joinRoom } from './fakes';

describe('room lobby', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a room with a 4-char code and makes the creator host', () => {
    const manager = new RoomManager({ random: () => 0 });
    const { connection, joined } = createRoom(manager);

    expect(joined.roomCode).toMatch(/^[A-Z2-9]{4}$/);
    expect(joined.token.length).toBeGreaterThan(0);
    expect(joined.room.hostId).toBe(joined.playerId);
    expect(joined.room.phase).toBe('lobby');
    expect(joined.room.seats).toEqual([
      { playerId: joined.playerId, nickname: 'Alice', stack: 5000, connected: true },
    ]);
    expect(connection.last('roomState')?.room.seats).toHaveLength(1);
  });

  it('lets a second player join and broadcasts the updated roster', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');

    expect(bob.joined.room.seats).toHaveLength(2);
    expect(alice.connection.last('roomState')?.room.seats.map((seat) => seat.nickname)).toEqual(['Alice', 'Bob']);
    expect(bob.joined.room.hostId).toBe(alice.joined.playerId);
  });

  it('rejects joining an unknown room or a full room', () => {
    const manager = new RoomManager();
    const stranger = connect(manager);
    sendCommand(manager, stranger, { type: 'joinRoom', roomCode: 'ZZZZ', nickname: 'X' });
    expect(stranger.last('error')?.code).toBe('room-not-found');

    const alice = createRoom(manager);
    for (let index = 0; index < 5; index += 1) {
      joinRoom(manager, alice.joined.roomCode, `P${index}`);
    }
    const seventh = connect(manager);
    sendCommand(manager, seventh, { type: 'joinRoom', roomCode: alice.joined.roomCode, nickname: 'Lucky' });
    expect(seventh.last('error')?.code).toBe('room-full');
  });

  it('rejects duplicate nicknames in the same room', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const copycat = connect(manager);
    sendCommand(manager, copycat, { type: 'joinRoom', roomCode: alice.joined.roomCode, nickname: 'Alice' });
    expect(copycat.last('error')?.code).toBe('nickname-taken');
  });

  it('removes leavers and migrates the host', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');

    sendCommand(manager, alice.connection, { type: 'leaveRoom' });

    const state = bob.connection.last('roomState')!.room;
    expect(state.seats.map((seat) => seat.nickname)).toEqual(['Bob']);
    expect(state.hostId).toBe(bob.joined.playerId);
  });

  it('destroys the room when the last player leaves', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    expect(manager.roomCount()).toBe(1);

    sendCommand(manager, alice.connection, { type: 'leaveRoom' });
    expect(manager.roomCount()).toBe(0);
  });

  it('marks a closed connection as disconnected and restores it on reconnect', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');

    manager.handleClose(bob.connection);
    expect(alice.connection.last('roomState')?.room.seats[1].connected).toBe(false);

    const back = connect(manager);
    sendCommand(manager, back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: bob.joined.token });

    expect(back.last('joined')?.playerId).toBe(bob.joined.playerId);
    expect(alice.connection.last('roomState')?.room.seats[1].connected).toBe(true);
  });

  it('rejects a formerly valid token after the same room code and nickname are reused', () => {
    const manager = new RoomManager({ random: () => 0 });
    const original = createRoom(manager, 'Alice');
    expect(original.joined.roomCode).toBe('AAAA');
    const oldToken = original.joined.token;
    sendCommand(manager, original.connection, { type: 'leaveRoom' });
    expect(manager.roomCount()).toBe(0);

    const replacement = createRoom(manager, 'Alice');
    expect(replacement.joined.roomCode).toBe(original.joined.roomCode);
    expect(replacement.joined.playerId).toBe(original.joined.playerId);
    expect(replacement.joined.token).not.toBe(oldToken);
    const before = replacement.connection.last('roomState')!.room;
    const messageCount = replacement.connection.sent.length;
    const stale = connect(manager);
    sendCommand(manager, stale, { type: 'reconnect', roomCode: original.joined.roomCode, token: oldToken });

    expect(stale.last('joined')).toBeUndefined();
    expect(stale.last('sessionEnded')).toBeDefined();
    expect(manager.roomCount()).toBe(1);
    expect(replacement.connection.sent).toHaveLength(messageCount);
    expect(replacement.connection.last('roomState')!.room).toEqual(before);
    expect(before.seats).toEqual([{ playerId: replacement.joined.playerId, nickname: 'Alice', stack: 5000, connected: true }]);
    expect(replacement.connection.last('error')).toBeUndefined();

    const valid = connect(manager);
    sendCommand(manager, valid, { type: 'reconnect', sessionId: replacement.joined.sessionId, roomCode: replacement.joined.roomCode, token: replacement.joined.token });
    expect(valid.last('joined')).toMatchObject({ playerId: replacement.joined.playerId, token: replacement.joined.token });
  });

  it('retains host ownership during a temporary disconnect and restores the same host seat', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
    manager.handleClose(alice.connection);
    const offline = bob.connection.last('roomState')!.room;
    expect(offline.hostId).toBe(alice.joined.playerId);
    expect(offline.seats.find(seat => seat.playerId === alice.joined.playerId)?.connected).toBe(false);
    sendCommand(manager, bob.connection, { type: 'startGame' });
    expect(bob.connection.last('error')?.code).toBe('not-host');

    const back = connect(manager);
    sendCommand(manager, back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: alice.joined.token });
    expect(back.last('joined')?.room.hostId).toBe(alice.joined.playerId);
    expect(back.last('joined')?.playerId).toBe(alice.joined.playerId);
    expect(bob.connection.last('roomState')?.room.seats).toHaveLength(2);
  });

  it('rejects reconnect with a bad token', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const back = connect(manager);
    sendCommand(manager, back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: 'wrong' });
    expect(back.last('error')?.code).toBe('invalid-proof');
  });

  it('rejects startGame from a non-host and from a room with one player', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);

    sendCommand(manager, alice.connection, { type: 'startGame' });
    expect(alice.connection.last('error')?.code).toBe('bad-message');

    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
    sendCommand(manager, bob.connection, { type: 'startGame' });
    expect(bob.connection.last('error')?.code).toBe('not-host');
  });

  it('rejects createRoom/joinRoom from a connection already seated', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const carol = createRoom(manager, 'Carol');

    sendCommand(manager, alice.connection, { type: 'joinRoom', roomCode: carol.joined.roomCode, nickname: 'Ally' });
    expect(alice.connection.last('error')?.code).toBe('bad-message');

    sendCommand(manager, alice.connection, { type: 'createRoom', nickname: 'Ally' });
    expect(alice.connection.last('error')?.code).toBe('bad-message');

    expect(alice.connection.last('roomState')?.room.seats).toHaveLength(1);
    expect(carol.connection.last('roomState')?.room.seats).toHaveLength(1);
  });

  it('keeps a reconnected seat online when the superseded connection closes', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');

    const back = connect(manager);
    sendCommand(manager, back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: bob.joined.token });
    expect(back.last('joined')?.playerId).toBe(bob.joined.playerId);

    // 顶号：旧连接收到 session-taken-over 并被关闭，不再静默悬挂
    expect(bob.connection.last('error')?.code).toBe('session-taken-over');

    manager.handleClose(bob.connection);
    expect(alice.connection.last('roomState')?.room.seats[1].connected).toBe(true);
  });

  it('rejects reconnect from a connection already seated', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);

    sendCommand(manager, alice.connection, { type: 'reconnect', roomCode: alice.joined.roomCode, token: alice.joined.token });
    expect(alice.connection.last('error')?.code).toBe('bad-message');
  });

  it('rejects leaveRoom from a connection not in any room', () => {
    const manager = new RoomManager();
    const stranger = connect(manager);
    sendCommand(manager, stranger, { type: 'leaveRoom' });
    expect(stranger.last('error')?.code).toBe('not-in-room');
  });

  it('never leaks another player\'s token in broadcasts', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');

    expect(JSON.stringify(alice.connection.sent)).not.toContain(bob.joined.token);
    expect(JSON.stringify(bob.connection.sent)).not.toContain(alice.joined.token);
  });
});


describe('room admission and recovery boundaries', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('requires a matching hello before any room allocation and acknowledges once', () => {
    const manager = new RoomManager();
    const raw = new FakeConnection();
    manager.handleOpen(raw);
    sendCommand(manager, raw, { type: 'createRoom', nickname: 'Old' });
    expect(raw.last('error')?.code).toBe('protocol-mismatch');
    expect(manager.roomCount()).toBe(0);
    sendCommand(manager, raw, { type: 'hello', protocolVersion: 1 });
    expect(raw.last('hello')).toBeUndefined();
    sendCommand(manager, raw, { type: 'hello', protocolVersion: PROTOCOL_VERSION });
    expect(raw.last('hello')).toEqual({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
    sendCommand(manager, raw, { type: 'createRoom', nickname: 'Alice' });
    expect(raw.last('joined')).toBeDefined();
  });

  it('sends joined before roster on admission and reconnect', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
    expect(bob.connection.sent.filter(m => m.type !== 'hello' && m.type !== 'roomLookup')[0].type).toBe('joined');
    manager.handleClose(bob.connection);
    const back = connect(manager);
    sendCommand(manager, back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: bob.joined.token });
    expect(back.sent.filter(m => m.type !== 'hello' && m.type !== 'roomLookup')[0].type).toBe('joined');
  });

  it('accepts just before 180 seconds and rejects the exact boundary even when cleanup is late', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
    const start = Date.now();
    manager.handleClose(bob.connection);
    vi.setSystemTime(start + 179_999);
    const back = connect(manager);
    sendCommand(manager, back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: bob.joined.token });
    expect(back.last('joined')?.playerId).toBe(bob.joined.playerId);
    manager.handleClose(back);
    const secondStart = Date.now();
    vi.setSystemTime(secondStart + 1000);
    manager.handleClose(back);
    vi.setSystemTime(secondStart + 180_000);
    const expired = connect(manager);
    sendCommand(manager, expired, { type: 'reconnect', roomCode: alice.joined.roomCode, token: bob.joined.token });
    expect(expired.last('joined')).toBeUndefined();
    expect(expired.last('error')?.code).toBe('room-not-found');
  });

  it('hands host to an online seat, or first valid recovery when all candidates are offline', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
    const carol = joinRoom(manager, alice.joined.roomCode, 'Carol');
    manager.handleClose(bob.connection);
    sendCommand(manager, alice.connection, { type: 'leaveRoom' });
    expect(carol.connection.last('roomState')?.room.hostId).toBe(carol.joined.playerId);
    sendCommand(manager, carol.connection, { type: 'leaveRoom' });
    const back = connect(manager);
    sendCommand(manager, back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: bob.joined.token });
    expect(back.last('joined')?.room.hostId).toBe(bob.joined.playerId);
  });
});


describe('pending host recovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('preserves a pending host until the first retained seat recovers', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
    const carol = joinRoom(manager, alice.joined.roomCode, 'Carol');
    manager.handleClose(bob.connection);
    manager.handleClose(carol.connection);
    sendCommand(manager, alice.connection, { type: 'leaveRoom' });
    const dave = joinRoom(manager, alice.joined.roomCode, 'Dave');
    expect(dave.joined.room.hostId).toBe('');
    const back = connect(manager);
    sendCommand(manager, back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: carol.joined.token });
    expect(back.last('joined')?.room.hostId).toBe(carol.joined.playerId);
    expect(dave.connection.last('roomState')?.room.hostId).toBe(carol.joined.playerId);
  });
});
