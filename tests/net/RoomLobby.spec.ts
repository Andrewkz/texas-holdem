import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RoomManager } from '../../server/src/RoomManager';
import { connect, createRoom, joinRoom } from './fakes';

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
    manager.handleMessage(stranger, { type: 'joinRoom', roomCode: 'ZZZZ', nickname: 'X' });
    expect(stranger.last('error')?.code).toBe('room-not-found');

    const alice = createRoom(manager);
    for (let index = 0; index < 5; index += 1) {
      joinRoom(manager, alice.joined.roomCode, `P${index}`);
    }
    const seventh = connect(manager);
    manager.handleMessage(seventh, { type: 'joinRoom', roomCode: alice.joined.roomCode, nickname: 'Lucky' });
    expect(seventh.last('error')?.code).toBe('room-full');
  });

  it('rejects duplicate nicknames in the same room', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const copycat = connect(manager);
    manager.handleMessage(copycat, { type: 'joinRoom', roomCode: alice.joined.roomCode, nickname: 'Alice' });
    expect(copycat.last('error')?.code).toBe('nickname-taken');
  });

  it('removes leavers and migrates the host', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');

    manager.handleMessage(alice.connection, { type: 'leaveRoom' });

    const state = bob.connection.last('roomState')!.room;
    expect(state.seats.map((seat) => seat.nickname)).toEqual(['Bob']);
    expect(state.hostId).toBe(bob.joined.playerId);
  });

  it('destroys the room when the last player leaves', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    expect(manager.roomCount()).toBe(1);

    manager.handleMessage(alice.connection, { type: 'leaveRoom' });
    expect(manager.roomCount()).toBe(0);
  });

  it('marks a closed connection as disconnected and restores it on reconnect', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');

    manager.handleClose(bob.connection);
    expect(alice.connection.last('roomState')?.room.seats[1].connected).toBe(false);

    const back = connect(manager);
    manager.handleMessage(back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: bob.joined.token });

    expect(back.last('joined')?.playerId).toBe(bob.joined.playerId);
    expect(alice.connection.last('roomState')?.room.seats[1].connected).toBe(true);
  });

  it('rejects reconnect with a bad token', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const back = connect(manager);
    manager.handleMessage(back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: 'wrong' });
    expect(back.last('error')?.code).toBe('room-not-found');
  });

  it('rejects startGame from a non-host and from a room with one player', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);

    manager.handleMessage(alice.connection, { type: 'startGame' });
    expect(alice.connection.last('error')?.code).toBe('bad-message');

    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
    manager.handleMessage(bob.connection, { type: 'startGame' });
    expect(bob.connection.last('error')?.code).toBe('not-host');
  });
});
