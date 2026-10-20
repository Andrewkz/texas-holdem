import { describe, expect, it } from 'vitest';

import { assessVisibleHand } from '../../assets/scripts/ai/AiHandStrength';
import { Card, Street } from '../../assets/scripts/core/types';

function cards(text: string): Card[] {
  return text.split(' ').map(code => ({
    rank: Number(code.slice(0, -1)) as Card['rank'],
    suit: code.slice(-1) as Card['suit'],
  }));
}

function assess(hole: string, board = '', street: Street = 'flop') {
  return assessVisibleHand(cards(hole), board ? cards(board) : [], street);
}

describe('assessVisibleHand', () => {
  it('ranks premium pairs above suited connectors and disconnected low cards before the flop', () => {
    const premium = assess('14S 14H', '', 'preflop');
    const connector = assess('9H 10H', '', 'preflop');
    const trash = assess('2C 7D', '', 'preflop');
    expect(premium.madeStrength).toBeGreaterThan(connector.madeStrength);
    expect(connector.madeStrength).toBeGreaterThan(trash.madeStrength);
    expect(premium.madeStrength).toBeLessThanOrEqual(1);
    expect(trash.madeStrength).toBeGreaterThanOrEqual(0);
    expect(premium.drawPotential).toBe(0);
  });

  it('recognizes actual made straights and flushes rather than just starting-card shape', () => {
    const straight = assess('12S 11D', '9C 10H 13S');
    const flush = assess('14H 8H', '2H 7H 11H');
    const pair = assess('9S 2D', '9C 13H 5S');
    expect(straight.madeStrength).toBeGreaterThan(0.8);
    expect(flush.madeStrength).toBeGreaterThan(straight.madeStrength);
    expect(pair.madeStrength).toBeLessThan(straight.madeStrength);
  });

  it('distinguishes top, middle and bottom pairs on the same board', () => {
    const board = '13C 9H 4S';
    const top = assess('13S 2D', board).madeStrength;
    const middle = assess('9S 2D', board).madeStrength;
    const bottom = assess('4C 2D', board).madeStrength;
    expect(top).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(bottom);
  });

  it('distinguishes overpairs and underpairs', () => {
    expect(assess('14S 14D', '13C 9H 4S').madeStrength)
      .toBeGreaterThan(assess('3S 3D', '13C 9H 4S').madeStrength);
  });

  it('does not credit a public pair or trips as a privately strong made hand', () => {
    expect(assess('9S 2D', '13C 13H 4S').madeStrength).toBeLessThan(0.4);
    expect(assess('9S 2D', '13C 13H 13S').madeStrength).toBeLessThan(0.5);
    expect(assess('13S 2D', '13C 13H 4S').madeStrength).toBeGreaterThan(0.75);
    expect(assess('4C 4D', '13C 13H 4S').madeStrength).toBeGreaterThan(0.9);
  });

  it('does not credit two public pairs as private two pair', () => {
    expect(assess('9S 2D', '13C 13H 4S 4D', 'turn').madeStrength).toBeLessThan(0.6);
  });

  it('marks a royal flush on the board as shared instead of a private monster', () => {
    const value = assess('2C 7D', '10H 11H 12H 13H 14H', 'river');
    expect(value.boardOnly).toBe(true);
    expect(value.sharedNuts).toBe(true);
    expect(value.madeStrength).toBeLessThan(0.6);
    expect(value.drawPotential).toBe(0);
  });

  it('only marks proven unbeatable shared royals, not shared king-high straight flushes', () => {
    const value = assess('2C 7D', '9H 10H 11H 12H 13H', 'river');
    expect(value.boardOnly).toBe(true);
    expect(value.sharedNuts).toBe(false);
    expect(assess('14H 13H', '10H 11H 12H').sharedNuts).toBe(false);
  });

  it('distinguishes shared board quads from a private kicker improvement', () => {
    const board = '13C 13H 13S 13D 4H';
    const shared = assess('2C 3D', board, 'river');
    const improved = assess('14C 3D', board, 'river');
    expect(shared.boardOnly).toBe(true);
    expect(improved.boardOnly).toBe(false);
    expect(improved.madeStrength).toBeGreaterThan(shared.madeStrength);
  });

  it('keeps privately held straight flushes near the top of the heuristic range', () => {
    expect(assess('14H 13H', '10H 11H 12H').madeStrength).toBeGreaterThanOrEqual(0.95);
  });

  it('recognizes four-card flush draws with one or two hole cards', () => {
    expect(assess('14H 8H', '2H 7H 11S').drawPotential).toBeGreaterThan(0.15);
    expect(assess('14H 8S', '2H 7H 11H').drawPotential).toBeGreaterThan(0.15);
  });

  it('does not award a flush draw merely because the starting hand is suited', () => {
    expect(assess('14H 8H', '2C 7D 11S').drawPotential).toBe(0);
  });

  it('does not claim a four-flush entirely on the board as its own draw', () => {
    expect(assess('14C 8S', '2H 7H 11H 5H', 'turn').drawPotential).toBe(0);
  });

  it('distinguishes open-ended straight draws from gutshots including an ace-low draw', () => {
    const openEnded = assess('7C 8D', '5S 6H 13C').drawPotential;
    const gutshot = assess('7C 9D', '5S 6H 13C').drawPotential;
    const wheel = assess('14C 2D', '3S 4H 13C').drawPotential;
    expect(openEnded).toBeGreaterThan(gutshot);
    expect(gutshot).toBeGreaterThan(0);
    expect(wheel).toBeGreaterThan(0);
    expect(wheel).toBeLessThan(openEnded);
  });

  it('requires a private rank contribution for a straight draw', () => {
    expect(assess('5C 13D', '5S 6H 7C 8D', 'turn').drawPotential).toBe(0);
  });

  it('does not count already made straights as unmade straight draws', () => {
    expect(assess('7C 8D', '4S 5H 6C').drawPotential).toBe(0);
  });

  it('removes missed draws on the river', () => {
    expect(assess('14H 8H', '2H 7H 11S 5C 9D', 'river').drawPotential).toBe(0);
  });

  it('uses only visible cards and does not mutate the supplied arrays', () => {
    const hole = Object.freeze(cards('14H 8H').map(Object.freeze));
    const board = Object.freeze(cards('2H 7H 11S').map(Object.freeze));
    const first = assessVisibleHand(hole, board, 'flop');
    expect(assessVisibleHand(hole, board, 'flop')).toEqual(first);
    expect(first.madeStrength).toBeGreaterThanOrEqual(0);
    expect(first.madeStrength).toBeLessThanOrEqual(1);
  });
});
