import { describe, expect, it } from 'vitest';

import { compareHands, evaluateBest, HandCategory } from '../../assets/scripts/core/HandEvaluator';
import { Card, Suit } from '../../assets/scripts/core/types';

const rankMap: Record<string, number> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

function cards(text: string): Card[] {
  return text.split(' ').map((token) => ({
    rank: rankMap[token[0]] as Card['rank'],
    suit: token[1] as Suit,
  }));
}

describe('HandEvaluator', () => {
  it('selects the best five cards from seven', () => {
    expect(evaluateBest(cards('AS KS QS JS TS 2D 3C')).category).toBe(HandCategory.StraightFlush);
    expect(evaluateBest(cards('AS 2H 3D 4C 5S KD QC')).tiebreak).toEqual([5]);
  });

  it('uses kickers when comparing the same category', () => {
    const queensKicker = evaluateBest(cards('AH AD KS KC QS'));
    const jacksKicker = evaluateBest(cards('AC AS KH KD JS'));

    expect(compareHands(queensKicker, jacksKicker)).toBeGreaterThan(0);
  });

  it('ties when the board supplies the same best hand', () => {
    const board = cards('AS KS QS JS TS');

    expect(compareHands(
      evaluateBest([...board, ...cards('2D 3D')]),
      evaluateBest([...board, ...cards('4C 5C')]),
    )).toBe(0);
  });
});
