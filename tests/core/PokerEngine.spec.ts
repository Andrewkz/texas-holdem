import { describe, expect, it } from 'vitest';

import { Deck } from '../../assets/scripts/core/Deck';
import { PokerEngine } from '../../assets/scripts/core/PokerEngine';
import { getPokerSeatLayout } from '../../assets/scripts/ui/PokerUiTheme';

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
  it('matches the physical clockwise seat order starting at the top seat', () => {
    const clockwise = getPokerSeatLayout()
      .sort((a, b) => ((Math.atan2(a.x, a.y) + 2 * Math.PI) % (2 * Math.PI))
        - ((Math.atan2(b.x, b.y) + 2 * Math.PI) % (2 * Math.PI)))
      .map(({ id }) => id);
    expect(clockwise).toEqual(['ai-1', 'ai-3', 'ai-4', 'player', 'ai-5', 'ai-2']);
    expect(engine().snapshot().players.map(({ id }) => id)).toEqual(clockwise);
  });

  it('posts blinds clockwise and follows the complete clockwise order on each street', () => {
    const game = engine();
    const started = game.startHand();
    expect(started.dealerPlayerId).toBe('ai-1');
    expect(started.players.find(({ id }) => id === 'ai-3')?.streetContribution).toBe(20);
    expect(started.players.find(({ id }) => id === 'ai-4')?.streetContribution).toBe(40);

    for (const [street, expected] of [
      ['preflop', ['player', 'ai-5', 'ai-2', 'ai-1', 'ai-3', 'ai-4']],
      ['flop', ['ai-3', 'ai-4', 'player', 'ai-5', 'ai-2', 'ai-1']],
      ['turn', ['ai-3', 'ai-4', 'player', 'ai-5', 'ai-2', 'ai-1']],
      ['river', ['ai-3', 'ai-4', 'player', 'ai-5', 'ai-2', 'ai-1']],
    ] as const) {
      const actors: string[] = [];
      while (game.snapshot().street === street) {
        actors.push(game.snapshot().actingPlayerId!);
        takePassiveAction(game);
      }
      expect(actors).toEqual(expected);
    }
    expect(game.snapshot().street).toBe('settled');
    expect(game.snapshot().players.reduce((sum, player) => sum + player.stack, 0)).toBe(30000);
  });

  it('rotates the button through every physical seat clockwise', () => {
    const game = engine();
    const dealers: string[] = [];
    for (let hand = 0; hand < 7; hand += 1) {
      dealers.push(game.startHand().dealerPlayerId!);
      while (game.snapshot().street !== 'settled') game.act({ type: 'fold' });
    }
    expect(dealers).toEqual(['ai-1', 'ai-3', 'ai-4', 'player', 'ai-5', 'ai-2', 'ai-1']);
  });

  it('skips empty physical seats for blinds, action and the next button', () => {
    const game = PokerEngine.createSixSeat({ random: () => 0.5, stacks: { 'ai-3': 0, 'ai-5': 0 } });
    const first = game.startHand();
    expect(first.dealerPlayerId).toBe('ai-1');
    expect(first.players.find(({ id }) => id === 'ai-4')?.streetContribution).toBe(20);
    expect(first.players.find(({ id }) => id === 'player')?.streetContribution).toBe(40);
    expect(first.actingPlayerId).toBe('ai-2');
    while (game.snapshot().street === 'preflop') takePassiveAction(game);
    expect(game.snapshot().actingPlayerId).toBe('ai-4');
    while (game.snapshot().street !== 'settled') game.act({ type: 'fold' });
    expect(game.startHand().dealerPlayerId).toBe('ai-4');
  });

  it('keeps dealer as small blind and big blind first after the flop with two occupied seats', () => {
    const game = PokerEngine.createSixSeat({
      random: () => 0.5,
      stacks: { 'ai-1': 0, 'ai-3': 0, 'ai-4': 0, 'ai-5': 0 },
    });
    const first = game.startHand();
    expect(first.dealerPlayerId).toBe('player');
    expect(first.players.find(({ id }) => id === 'player')?.streetContribution).toBe(20);
    expect(first.players.find(({ id }) => id === 'ai-2')?.streetContribution).toBe(40);
    expect(first.actingPlayerId).toBe('player');
    takePassiveAction(game);
    takePassiveAction(game);
    expect(game.snapshot().street).toBe('flop');
    expect(game.snapshot().actingPlayerId).toBe('ai-2');
  });

  it('automatically posts a short big blind all-in and skips it in the action order', () => {
    const game = PokerEngine.createSixSeat({ random: () => 0.5, stacks: { 'ai-4': 25 } });
    const first = game.startHand();
    expect(first.players.find(({ id }) => id === 'ai-4')).toMatchObject({
      stack: 0, allIn: true, streetContribution: 25,
    });
    expect(first.actingPlayerId).toBe('player');
    const actors: string[] = [];
    while (game.snapshot().street === 'preflop') {
      actors.push(game.snapshot().actingPlayerId!);
      takePassiveAction(game);
    }
    expect(actors).toEqual(['player', 'ai-5', 'ai-2', 'ai-1', 'ai-3']);
  });

  it('collects blinds and exposes legal preflop actions to the next active player', () => {
    const game = engine();
    const state = game.startHand();

    expect(state.pot).toBe(60);
    expect(state.actingPlayerId).toBe('player');
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
    expect(state.actingPlayerId).toBe('ai-3');
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

  it('lets the first actor cover a call with a short all-in', () => {
    const game = PokerEngine.createSixSeat({
      deck: new Deck(() => 0.5),
      stacks: { player: 25 },
    });
    game.startHand();

    game.act({ type: 'all-in' });

    expect(game.snapshot().players.find(({ id }) => id === 'player')).toMatchObject({
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
      playerId: 'player',
      action: { type: 'raise', to: 160 },
      amount: 160,
    }));
    expect(game.snapshot().players.find(({ id }) => id === 'player')).toMatchObject({
      streetContribution: 160,
      stack: 4840,
    });
  });
});


describe('createWithPlayers', () => {
  const two = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];

  it('rejects tables with fewer than 2 or more than 6 players', () => {
    expect(() => PokerEngine.createWithPlayers([{ id: 'a', name: 'A' }])).toThrow('between 2 and 6');
    expect(() => PokerEngine.createWithPlayers(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id, name: id })),
    )).toThrow('between 2 and 6');
  });

  it('posts the small blind from the dealer in heads-up play', () => {
    const game = PokerEngine.createWithPlayers(two, { random: () => 0.5 });
    const state = game.startHand();

    expect(state.dealerPlayerId).toBe('a');
    expect(state.players.find(({ id }) => id === 'a')).toMatchObject({ streetContribution: 20 });
    expect(state.players.find(({ id }) => id === 'b')).toMatchObject({ streetContribution: 40 });
    expect(state.actingPlayerId).toBe('a');
  });

  it('rotates the dealer to the next player on the following hand', () => {
    const game = PokerEngine.createWithPlayers(two, { random: () => 0.5 });
    game.startHand();
    game.act({ type: 'fold' });
    expect(game.snapshot().street).toBe('settled');

    const next = game.startHand();
    expect(next.dealerPlayerId).toBe('b');
    expect(next.players.find(({ id }) => id === 'b')).toMatchObject({ streetContribution: 20 });
  });

  it('honours initialDealerIndex when recreating a table', () => {
    const game = PokerEngine.createWithPlayers(two, { random: () => 0.5, initialDealerIndex: 0 });
    expect(game.startHand().dealerPlayerId).toBe('b');
  });

  it('keeps the standard blind order with three or more players', () => {
    const game = PokerEngine.createWithPlayers(
      [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
      { random: () => 0.5 },
    );
    const state = game.startHand();

    expect(state.dealerPlayerId).toBe('a');
    expect(state.players.find(({ id }) => id === 'b')).toMatchObject({ streetContribution: 20 });
    expect(state.players.find(({ id }) => id === 'c')).toMatchObject({ streetContribution: 40 });
    expect(state.actingPlayerId).toBe('a');
  });

  it('rejects duplicate player ids', () => {
    expect(() => PokerEngine.createWithPlayers(
      [{ id: 'a', name: 'A' }, { id: 'a', name: 'A2' }],
    )).toThrow('Duplicate player id');
  });

  it('lets the big blind act first on the flop in heads-up play', () => {
    const game = PokerEngine.createWithPlayers(two, { random: () => 0.5 });
    game.startHand();

    game.act({ type: 'call', amount: 20 });
    expect(game.snapshot().actingPlayerId).toBe('b');
    game.act({ type: 'check' });

    const flop = game.snapshot();
    expect(flop.street).toBe('flop');
    expect(flop.actingPlayerId).toBe('b');
    expect(flop.dealerPlayerId).toBe('a');
  });

  it('runs out the board without crashing when both players are all-in', () => {
    const game = PokerEngine.createWithPlayers(two, { random: () => 0.5 });
    game.startHand();

    // heads-up：a 是庄家/小盲先行动，all-in 后 b 跟注，两人筹码全部入池
    game.act({ type: 'all-in' });
    game.act({ type: 'call', amount: 4960 });

    const settled = game.snapshot();
    expect(settled.street).toBe('settled');
    expect(settled.communityCards).toHaveLength(5);
    expect(settled.players.reduce((sum, player) => sum + player.stack, 0)).toBe(10000);
  });

  it('runs out the board immediately when both blinds are all-in', () => {
    const game = PokerEngine.createWithPlayers(
      [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      { random: () => 0.5, stacks: { a: 20, b: 40 } },
    );

    const state = game.startHand();

    expect(state.street).toBe('settled');
    expect(state.communityCards).toHaveLength(5);
    const total = state.players.reduce((sum, player) => sum + player.stack, 0);
    expect(total).toBe(60);
  });
});
