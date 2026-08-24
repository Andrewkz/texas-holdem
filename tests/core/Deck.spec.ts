import { describe, expect, it } from 'vitest';

import { Deck } from '../../assets/scripts/core/Deck';

describe('Deck', () => {
  it('contains 52 unique cards and draws without replacement', () => {
    const deck = new Deck(() => 0.5);
    const drawn = Array.from({ length: 52 }, () => deck.draw());

    expect(new Set(drawn.map((card) => `${card.rank}${card.suit}`)).size).toBe(52);
    expect(() => deck.draw()).toThrow('Deck is empty');
  });
});
