import { describe, expect, it } from 'vitest';
import { PokerEngine } from '../../assets/scripts/core/PokerEngine';
function engine(count = 3) {
  return PokerEngine.createWithPlayers(Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` })), { random: () => 0.5 });
}
describe('forced departure folds', () => {
  it('immediately folds an ordinary out-of-turn participant without skipping the current actor', () => {
    const game = engine();
    game.startHand();
    expect(game.snapshot().actingPlayerId).toBe('p1');
    const events = game.forceFoldPlayer('p2');
    expect(events).toContainEqual(expect.objectContaining({ type: 'action-taken', playerId: 'p2', action: { type: 'fold' } }));
    expect(game.snapshot().players.find(p => p.id === 'p2')?.folded).toBe(true);
    expect(game.snapshot().actingPlayerId).toBe('p1');
    game.act({ type: 'fold' });
    expect(game.snapshot().street).toBe('settled');
    expect(game.snapshot().players.find(p => p.id === 'p3')?.stack).toBe(5020);
  });
  it('settles heads-up immediately when a participant who already called leaves out of turn', () => {
    const game = engine(2);
    game.startHand();
    game.act({ type: 'call', amount: 20 });
    expect(game.snapshot().actingPlayerId).toBe('p2');
    const events = game.forceFoldPlayer('p1');
    expect(game.snapshot().street).toBe('settled');
    expect(events).toContainEqual(expect.objectContaining({ type: 'pot-awarded', playerId: 'p2', amount: 80 }));
    expect(game.snapshot().players.map(p => p.stack)).toEqual([4960, 5040]);
    expect(game.forceFoldPlayer('p2')).toEqual([]);
  });
  it('uses normal advancement for the current actor and is idempotent for repeated departed players', () => {
    const game = engine(4);
    game.startHand();
    const actor = game.snapshot().actingPlayerId!;
    game.forceFoldPlayer(actor);
    const after = game.snapshot();
    expect(after.actingPlayerId).not.toBe(actor);
    expect(game.forceFoldPlayer(actor)).toEqual([]);
    expect(game.snapshot()).toEqual(after);
  });
  it('retains all-in eligibility and pending opponent action when an all-in participant leaves', () => {
    const game = engine();
    game.startHand();
    game.act({ type: 'all-in' });
    const after = game.snapshot();
    expect(game.forceFoldPlayer('p1')).toEqual([]);
    expect(game.snapshot()).toEqual(after);
    expect(game.snapshot().players.find(p => p.id === 'p1')).toMatchObject({ folded: false, allIn: true });
    game.forceFoldPlayer('p2');
    game.forceFoldPlayer('p3');
    expect(game.snapshot().players.find(p => p.id === 'p1')?.stack).toBe(5060);
    expect(game.snapshot().street).toBe('settled');
  });
});
