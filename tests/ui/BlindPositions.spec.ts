import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../assets/scripts/core/types';
import { PokerEngine } from '../../assets/scripts/core/PokerEngine';
import { deriveBlindPositions, fromSoloBlindEvents } from '../../assets/scripts/ui/BlindPositions';

const seats = ['a', 'b', 'c', 'd', 'e', 'player'];
function events(ids: readonly string[], sb: string, bb: string, handId = 1): EngineEvent[] {
  return [
    { handId, type: 'blind-posted', playerId: sb, amount: 20 },
    { handId, type: 'blind-posted', playerId: bb, amount: 40 },
    ...ids.map((playerId): EngineEvent => ({ handId, type: 'hole-card-dealt', playerId, faceDown: true })),
  ];
}

describe('deriveBlindPositions', () => {
  it('finds the next two occupied seats clockwise and wraps around the dealer', () => {
    expect(deriveBlindPositions(7, seats, 'player')).toEqual({ handId: 7, dealerPlayerId: 'player', smallBlindPlayerId: 'a', bigBlindPlayerId: 'b' });
    expect(deriveBlindPositions(7, ['a', 'd', 'player'], 'd')).toEqual({ handId: 7, dealerPlayerId: 'd', smallBlindPlayerId: 'player', bigBlindPlayerId: 'a' });
  });
  it('gives the dealer the small blind when heads up', () => {
    expect(deriveBlindPositions(8, ['a', 'player'], 'player')).toEqual({ handId: 8, dealerPlayerId: 'player', smallBlindPlayerId: 'player', bigBlindPlayerId: 'a' });
  });
  it('keeps positions for the original hand participants and changes them only for the next dealer', () => {
    const participants = Object.freeze(['a', 'b', 'player']);
    const before = deriveBlindPositions(1, participants, 'a');
    expect(deriveBlindPositions(1, participants, 'a')).toEqual(before);
    expect(deriveBlindPositions(2, participants, 'b')).toEqual({ handId: 2, dealerPlayerId: 'b', smallBlindPlayerId: 'player', bigBlindPlayerId: 'a' });
    expect(participants).toEqual(['a', 'b', 'player']);
  });
  it.each([
    [0, ['a', 'b'], 'a'], [-1, ['a', 'b'], 'a'], [1.2, ['a', 'b'], 'a'], [NaN, ['a', 'b'], 'a'],
    [1, [], 'a'], [1, ['a'], 'a'], [1, ['a', 'a'], 'a'], [1, ['a', ''], 'a'],
    [1, ['a', ' '], 'a'], [1, ['a', 'b'], 'missing'], [1, ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'a'],
  ] as const)('rejects malformed positions %#', (hand, ids, dealer) => {
    expect(deriveBlindPositions(hand, ids, dealer)).toBeNull();
  });
});

describe('fromSoloBlindEvents', () => {
  it('uses this hand deal recipients, including short all-ins, and skips seats sitting out', () => {
    const dealt = events(['a', 'd', 'player'], 'd', 'player');
    dealt[0] = { handId: 1, type: 'blind-posted', playerId: 'd', amount: 3 };
    dealt[1] = { handId: 1, type: 'blind-posted', playerId: 'player', amount: 2 };
    expect(fromSoloBlindEvents(1, seats, dealt, 'a')).toEqual({ handId: 1, dealerPlayerId: 'a', smallBlindPlayerId: 'd', bigBlindPlayerId: 'player' });
  });
  it('restores heads-up dealer and blinds from an immediately settled short-stack hand', () => {
    const engine = PokerEngine.createWithPlayers([{ id: 'a', name: 'A' }, { id: 'player', name: 'You' }], { stacks: { a: 3, player: 2 }, random: () => .5 });
    const state = engine.startHand();
    expect(state.street).toBe('settled');
    expect(state.dealerPlayerId).toBeNull();
    expect(fromSoloBlindEvents(state.handId, ['a', 'player'], engine.takeEvents(), state.dealerPlayerId)).toEqual({ handId: 1, dealerPlayerId: 'a', smallBlindPlayerId: 'a', bigBlindPlayerId: 'player' });
  });
  it('recovers a three-way dealer from the participant preceding the posted small blind', () => {
    expect(fromSoloBlindEvents(1, seats, events(['a', 'd', 'player'], 'a', 'd'), null)).toEqual({ handId: 1, dealerPlayerId: 'player', smallBlindPlayerId: 'a', bigBlindPlayerId: 'd' });
  });
  it('does not move the markers when those participants fold later in the hand', () => {
    const dealt = events(seats, 'b', 'c');
    const original = fromSoloBlindEvents(1, seats, dealt, 'a');
    dealt.push({ handId: 1, type: 'action-taken', playerId: 'b', action: { type: 'fold' }, amount: 0 });
    dealt.push({ handId: 1, type: 'action-taken', playerId: 'c', action: { type: 'all-in' }, amount: 4960 });
    expect(fromSoloBlindEvents(1, seats, dealt, 'a')).toEqual(original);
  });
  it('ignores old-hand events and never uses their blind posts or private cards', () => {
    const mixed = [...events(seats, 'b', 'c', 1), ...events(['a', 'd', 'player'], 'a', 'd', 2)];
    expect(fromSoloBlindEvents(2, seats, mixed, 'player')).toEqual({ handId: 2, dealerPlayerId: 'player', smallBlindPlayerId: 'a', bigBlindPlayerId: 'd' });
    expect(fromSoloBlindEvents(3, seats, mixed, 'player')).toBeNull();
  });
  it('ignores duplicate deal events without reading card values or mutating inputs', () => {
    const dealt = events(['a', 'player'], 'a', 'player');
    dealt.push({ handId: 1, type: 'hole-card-dealt', playerId: 'a', faceDown: true, get card() { throw new Error('Do not read hole cards'); } });
    Object.freeze(dealt);
    expect(fromSoloBlindEvents(1, Object.freeze(seats), dealt, 'a')).toEqual({ handId: 1, dealerPlayerId: 'a', smallBlindPlayerId: 'a', bigBlindPlayerId: 'player' });
  });
  it('rejects missing blinds, unknown participants, duplicated blind seats and inconsistent dealers', () => {
    expect(fromSoloBlindEvents(1, seats, [], 'a')).toBeNull();
    expect(fromSoloBlindEvents(1, seats, events(['a', 'player'], 'a', 'a'), null)).toBeNull();
    expect(fromSoloBlindEvents(1, seats, events(['a', 'ghost'], 'a', 'ghost'), null)).toBeNull();
    expect(fromSoloBlindEvents(1, seats, events(seats, 'b', 'c'), 'd')).toBeNull();
    expect(fromSoloBlindEvents(1, ['a', 'a'], events(['a', 'player'], 'a', 'player'), 'a')).toBeNull();
    expect(fromSoloBlindEvents(0, seats, events(seats, 'b', 'c'), 'a')).toBeNull();
  });
});
