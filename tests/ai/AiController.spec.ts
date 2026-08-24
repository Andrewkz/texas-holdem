import { describe, expect, it } from 'vitest';

import { chooseAiAction } from '../../assets/scripts/ai/AiController';
import { Card, PlayerAction, Suit } from '../../assets/scripts/core/types';

function card(rank: number, suit: Suit): Card {
  return { rank: rank as Card['rank'], suit };
}

function context(overrides: Partial<Parameters<typeof chooseAiAction>[0]> = {}) {
  return {
    holeCards: [card(2, 'C'), card(7, 'D')],
    communityCards: [],
    street: 'preflop' as const,
    pot: 60,
    toCall: 40,
    stack: 5000,
    legalActions: [{ type: 'fold' }, { type: 'call', amount: 40 }] as PlayerAction[],
    random: () => 0.1,
    ...overrides,
  };
}

describe('chooseAiAction', () => {
  it('does not raise when only fold and call are legal', () => {
    expect(chooseAiAction(context())).toEqual({ type: 'fold' });
  });

  it('uses a legal raise for a premium preflop pair', () => {
    expect(chooseAiAction(context({
      holeCards: [card(14, 'S'), card(14, 'H')],
      legalActions: [{ type: 'fold' }, { type: 'call', amount: 40 }, { type: 'raise', to: 120 }, { type: 'all-in' }],
    }))).toEqual({ type: 'raise', to: 120 });
  });

  it('uses all-in when it is the only non-fold action', () => {
    expect(chooseAiAction(context({
      stack: 25,
      legalActions: [{ type: 'fold' }, { type: 'all-in' }],
    }))).toEqual({ type: 'all-in' });
  });
});
