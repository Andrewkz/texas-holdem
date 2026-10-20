import { describe, expect, it } from 'vitest';

import { createRoomInvite, normalizeRoomCode, parseRoomInvite } from '../../assets/scripts/net/RoomInvite';

describe('room invitations', () => {
  it.each(['AB23', 'YZ89', 'CD45', 'HJKN'])('accepts the complete room alphabet for %s', (roomCode) => {
    expect(normalizeRoomCode(` ${roomCode.toLowerCase()} `)).toBe(roomCode);
    expect(parseRoomInvite(`?room=${roomCode.toLowerCase()}`)).toEqual({ kind: 'valid', roomCode });
  });

  it('distinguishes absence from an explicit invalid invitation', () => {
    expect(parseRoomInvite('?server=wss://other.test/ws')).toEqual({ kind: 'none' });
    for (const search of ['?room=', '?room', '?room=AB2', '?room=ABCDE', '?room=AB0O', '?room=ABIL', '?room=AB%2523', '?room=AB23&room=CD45', '?room=AB23&room=']) {
      expect(parseRoomInvite(search)).toEqual({ kind: 'invalid', message: expect.any(String) });
    }
  });

  it('accepts repeated parameters only when they agree after normalization', () => {
    expect(parseRoomInvite('?room=ab23&room=%20AB23%20')).toEqual({ kind: 'valid', roomCode: 'AB23' });
  });

  it.each([
    ['https://example.test/poker/?server=wss://other.test/ws&token=private&nickname=Alice#old', 'https://example.test/poker/?room=AB23'],
    ['http://192.0.2.20:8080/games/poker.html?token=secret#lobby', 'http://192.0.2.20:8080/games/poker.html?room=AB23'],
  ])('creates a public invite retaining the deployment path for %s', (pageUrl, expected) => {
    expect(createRoomInvite(pageUrl, ' ab23 ')).toBe(expected);
  });

  it('permits sharing only for the site deployment backend', () => {
    expect(createRoomInvite('https://example.test/poker/', 'AB23', 'wss://EXAMPLE.test:443/ws')).toBe('https://example.test/poker/?room=AB23');
    expect(createRoomInvite('http://localhost:7456/', 'AB23', 'ws://localhost:2567/')).toBe('http://localhost:7456/?room=AB23');
    for (const endpoint of ['wss://other.test/ws', 'ws://example.test/ws', 'wss://example.test:8443/ws', 'wss://example.test/other', 'wss://example.test/ws?game=other']) {
      expect(() => createRoomInvite('https://example.test/poker/', 'AB23', endpoint)).toThrow();
    }
  });

  it('refuses invalid rooms and nonportable or credential-bearing page URLs', () => {
    expect(() => createRoomInvite('https://example.test/', 'AB0O')).toThrow();
    for (const pageUrl of ['not a url', 'file:///game/index.html', 'ws://example.test/', 'https://alice:private@example.test/']) {
      expect(() => createRoomInvite(pageUrl, 'AB23')).toThrow();
    }
  });
});
