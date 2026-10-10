import { describe, expect, it } from 'vitest';

import { parseClientMessage } from '../../assets/scripts/net/protocol';

describe('parseClientMessage', () => {
  it('parses a createRoom message and trims the nickname', () => {
    expect(parseClientMessage({ type: 'createRoom', nickname: '  Alice  ' }))
      .toEqual({ type: 'createRoom', nickname: 'Alice' });
  });

  it('parses joinRoom and reconnect messages', () => {
    expect(parseClientMessage({ type: 'joinRoom', roomCode: 'ABCD', nickname: 'Bob' }))
      .toEqual({ type: 'joinRoom', roomCode: 'ABCD', nickname: 'Bob' });
    expect(parseClientMessage({ type: 'reconnect', roomCode: 'ABCD', token: 'tok' }))
      .toEqual({ type: 'reconnect', roomCode: 'ABCD', token: 'tok' });
  });

  it('parses leaveRoom and startGame messages', () => {
    expect(parseClientMessage({ type: 'leaveRoom' })).toEqual({ type: 'leaveRoom' });
    expect(parseClientMessage({ type: 'startGame' })).toEqual({ type: 'startGame' });
  });

  it('parses every action variant', () => {
    expect(parseClientMessage({ type: 'action', action: { type: 'fold' } }))
      .toEqual({ type: 'action', action: { type: 'fold' } });
    expect(parseClientMessage({ type: 'action', action: { type: 'check' } }))
      .toEqual({ type: 'action', action: { type: 'check' } });
    expect(parseClientMessage({ type: 'action', action: { type: 'all-in' } }))
      .toEqual({ type: 'action', action: { type: 'all-in' } });
    expect(parseClientMessage({ type: 'action', action: { type: 'call', amount: 40 } }))
      .toEqual({ type: 'action', action: { type: 'call', amount: 40 } });
    expect(parseClientMessage({ type: 'action', action: { type: 'raise', to: 160 } }))
      .toEqual({ type: 'action', action: { type: 'raise', to: 160 } });
  });

  it('rejects malformed messages', () => {
    expect(parseClientMessage(null)).toBeNull();
    expect(parseClientMessage('createRoom')).toBeNull();
    expect(parseClientMessage({ type: 'nope' })).toBeNull();
    expect(parseClientMessage({ type: 'createRoom', nickname: 42 })).toBeNull();
    expect(parseClientMessage({ type: 'createRoom', nickname: '   ' })).toBeNull();
    expect(parseClientMessage({ type: 'createRoom', nickname: 'this-name-is-way-too-long' })).toBeNull();
    expect(parseClientMessage({ type: 'joinRoom', roomCode: 123, nickname: 'Bob' })).toBeNull();
    expect(parseClientMessage({ type: 'reconnect', roomCode: 'ABCD' })).toBeNull();
    expect(parseClientMessage({ type: 'action', action: { type: 'call' } })).toBeNull();
    expect(parseClientMessage({ type: 'action', action: { type: 'raise', to: 'big' } })).toBeNull();
    expect(parseClientMessage({ type: 'action', action: { type: 'surrender' } })).toBeNull();
    expect(parseClientMessage({ type: 'action' })).toBeNull();
    expect(parseClientMessage({ type: 'action', action: { type: 'call', amount: NaN } })).toBeNull();
    expect(parseClientMessage({ type: 'action', action: { type: 'raise', to: -100 } })).toBeNull();
    expect(parseClientMessage({ type: 'action', action: { type: 'raise', to: Infinity } })).toBeNull();
  });
});
