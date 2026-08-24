import { describe, expect, it } from 'vitest';

import { Deck } from '../../assets/scripts/core/Deck';
import { PokerEngine } from '../../assets/scripts/core/PokerEngine';

function engine(): PokerEngine {
  return PokerEngine.createSixSeat({ deck: new Deck(() => 0.5) });
}

function takePassiveAction(game: PokerEngine): void {
  const action = game.snapshot().legalActions.find(({ type }) => type === 'check')
    ?? game.snapshot().legalActions.find(({ type }) => type === 'call');

  if (!action) {
    throw new Error('Expected a passive legal action');
  }

  game.act(action);
}

describe('PokerEngine', () => {
  it('collects blinds and exposes legal preflop actions to the next active player', () => {
    const game = engine();
    const state = game.startHand();

    expect(state.pot).toBe(60);
    expect(state.actingPlayerId).toBe('ai-4');
    expect(state.legalActions).toContainEqual({ type: 'call', amount: 40 });
    expect(() => game.act({ type: 'check' })).toThrow('Illegal action');
  });

  it('reveals the flop after every active seat has matched the big blind', () => {
    const game = engine();
    game.startHand();

    while (game.snapshot().street === 'preflop') {
      takePassiveAction(game);
    }

    const state = game.snapshot();
    expect(state.street).toBe('flop');
    expect(state.communityCards).toHaveLength(3);
    expect(state.actingPlayerId).toBe('ai-2');
  });

  it('awards all contributed chips when every opponent folds', () => {
    const game = engine();
    game.startHand();

    while (game.snapshot().street !== 'settled') {
      const state = game.snapshot();
      const action = state.actingPlayerId === 'player'
        ? state.legalActions.find(({ type }) => type === 'call') ?? state.legalActions.find(({ type }) => type === 'check')!
        : state.legalActions.find(({ type }) => type === 'fold')!;

      game.act(action);
    }

    expect(game.snapshot().players.find(({ id }) => id === 'player')?.stack).toBe(5060);
    expect(game.snapshot().pot).toBe(0);
  });

  it('puts a short stack all-in when it cannot cover the big blind', () => {
    const game = PokerEngine.createSixSeat({
      deck: new Deck(() => 0.5),
      stacks: { 'ai-4': 25 },
    });
    game.startHand();

    game.act({ type: 'all-in' });

    expect(game.snapshot().players.find(({ id }) => id === 'ai-4')).toMatchObject({
      stack: 0,
      allIn: true,
      totalContribution: 25,
    });
    expect(game.snapshot().actingPlayerId).toBe('ai-5');
  });

  it('accepts a raise amount above the minimum when the player can cover it', () => {
    const game = engine();
    game.startHand();

    const events = game.act({ type: 'raise', to: 160 });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'action-taken',
      playerId: 'ai-4',
      action: { type: 'raise', to: 160 },
      amount: 160,
    }));
    expect(game.snapshot().players.find(({ id }) => id === 'ai-4')).toMatchObject({
      streetContribution: 160,
      stack: 4840,
    });
  });
});
