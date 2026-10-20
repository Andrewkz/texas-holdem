import { describe, expect, it } from 'vitest';
import type { EngineSnapshot, PlayerSnapshot } from '../../assets/scripts/core/types';
import { createChipScale, getChipProportion, MAX_CHIP_VISUALS, getChipPilePosition, getPokerChipPiles, getPotChipPilePosition } from '../../assets/scripts/ui/PokerChipModel';
import { getPokerSeatLayout } from '../../assets/scripts/ui/PokerUiTheme';
import { getPokerViewport } from '../../assets/scripts/ui/PokerViewport';

function snapshot(pot: number, contributions: number[], street: EngineSnapshot['street'] = 'preflop'): EngineSnapshot {
  return { handId: 1, street, actingPlayerId: 'player', dealerPlayerId: 'player', pot,
    communityCards: [], legalActions: [], players: contributions.map((amount, index): PlayerSnapshot => ({
      id: index ? `ai-${index}` : 'player', name: String(index), stack: 5000 - amount,
      folded: false, allIn: false, streetContribution: amount, totalContribution: amount,
    })) };
}

describe('shared chip proportions', () => {
  it('gives an empty or zero table no visible piles', () => {
    for (const amounts of [[], [0], [0, 0]]) {
      const scale = createChipScale(amounts);
      expect(scale).toEqual({ maxAmount: 0, unitAmount: 0, maxVisuals: 12 });
      expect(getChipProportion(0, scale)).toEqual({ ratio: 0, units: 0, whole: 0, fraction: 0, visibleCount: 0 });
    }
  });
  it('compares every pile against the same table maximum', () => {
    const scale = createChipScale([100, 200, 1000]);
    expect(scale).toEqual({ maxAmount: 1000, unitAmount: 1000 / 12, maxVisuals: 12 });
    const hundred = getChipProportion(100, scale);
    expect(hundred).toMatchObject({ ratio: 0.1, whole: 1, visibleCount: 2 });
    expect(hundred.units).toBeCloseTo(1.2, 12);
    expect(hundred.fraction).toBeCloseTo(0.2, 12);
    expect(getChipProportion(200, scale).units).toBeCloseTo(2.4, 12);
    expect(getChipProportion(1000, scale)).toEqual({ ratio: 1, units: 12, whole: 12, fraction: 0, visibleCount: 12 });
    expect(getChipProportion(200, scale).units / getChipProportion(100, scale).units).toBe(2);
  });
  it('uses identical proportions for identical pot and wager amounts', () => {
    const piles = getPokerChipPiles(snapshot(300, [100, 100], 'flop'));
    const amounts = [piles.pot, ...piles.wagers.map(wager => wager.amount)];
    const scale = createChipScale(amounts);
    expect(amounts).toEqual([100, 100, 100]);
    expect(amounts.map(amount => getChipProportion(amount, scale).units)).toEqual([12, 12, 12]);
  });
  it('preserves blind and odd-chip relative amounts', () => {
    const blinds = createChipScale([20, 40]);
    expect(getChipProportion(20, blinds).units).toBe(6);
    expect(getChipProportion(40, blinds).units).toBe(12);
    const odds = createChipScale([1, 3]);
    expect(getChipProportion(1, odds).units).toBe(4);
    expect(getChipProportion(3, odds).units).toBe(12);
  });
  it('does not multiply large money amounts or create more than twelve visuals', () => {
    const scale = createChipScale([Number.MAX_SAFE_INTEGER]);
    const max = getChipProportion(Number.MAX_SAFE_INTEGER, scale);
    expect(max.units).toBe(12);
    expect(max.visibleCount).toBe(MAX_CHIP_VISUALS);
    const half = getChipProportion(Math.floor(Number.MAX_SAFE_INTEGER / 2), scale);
    expect(half.units).toBeCloseTo(6, 12);
    expect(half.whole).toBe(6);
    expect(half.fraction).toBe(0);
    const tiny = getChipProportion(1, scale);
    expect(tiny.units).toBeGreaterThan(0);
    expect(tiny.visibleCount).toBe(1);
  });
  it('avoids spurious remainder nodes at floating-point integer boundaries', () => {
    const scale = createChipScale([100]);
    expect(getChipProportion(25, scale)).toEqual({ ratio: 0.25, units: 3, whole: 3, fraction: 0, visibleCount: 3 });
    expect(getChipProportion(75, scale).visibleCount).toBe(9);
  });
  it('keeps display quantity monotonically increasing without changing source arrays', () => {
    const amounts = Object.freeze([0, 1, 2, 3, 20, 100, 200, 500, 999, 1000]);
    const scale = Object.freeze(createChipScale(amounts));
    let lastUnits = -1;
    for (const amount of amounts) {
      const proportion = getChipProportion(amount, scale);
      expect(proportion.units).toBeGreaterThan(lastUnits);
      expect(proportion.visibleCount).toBeLessThanOrEqual(12);
      expect(proportion.units).toBeCloseTo(proportion.whole + proportion.fraction, 12);
      lastUnits = proportion.units;
    }
    expect(amounts).toEqual([0, 1, 2, 3, 20, 100, 200, 500, 999, 1000]);
  });
  it('rejects an amount above the shared maximum', () => {
    expect(() => getChipProportion(101, createChipScale([100]))).toThrow(RangeError);
    expect(() => getChipProportion(1, createChipScale([]))).toThrow(RangeError);
  });
  it.each([
    { maxAmount: -1, unitAmount: 0, maxVisuals: 12 },
    { maxAmount: 1.5, unitAmount: 0.125, maxVisuals: 12 },
    { maxAmount: Infinity, unitAmount: Infinity, maxVisuals: 12 },
    { maxAmount: 100, unitAmount: 10, maxVisuals: 12 },
    { maxAmount: 0, unitAmount: 1, maxVisuals: 12 },
    { maxAmount: 100, unitAmount: 100 / 12, maxVisuals: 3 },
    { maxAmount: 100, unitAmount: NaN, maxVisuals: 12 },
  ])('rejects inconsistent or invalid shared scale %s', scale => {
    expect(() => getChipProportion(0, scale)).toThrow(RangeError);
  });
});

describe('PokerChipModel', () => {
  it('leaves an empty table without token piles', () => {
    expect(getPokerChipPiles(snapshot(0, [0, 0]))).toEqual({ pot: 0, totalPot: 0, wagers: [] });
  });
  it('keeps posted blinds at their seats without counting them twice in the middle', () => {
    expect(getPokerChipPiles(snapshot(60, [20, 40]))).toEqual({ pot: 0, totalPot: 60,
      wagers: [{ playerId: 'player', amount: 20 }, { playerId: 'ai-1', amount: 40 }] });
  });
  it('collects the previous street while leaving fresh bets at their owners', () => {
    expect(getPokerChipPiles(snapshot(265, [25, 40, 0], 'flop'))).toEqual({ pot: 200, totalPot: 265,
      wagers: [{ playerId: 'player', amount: 25 }, { playerId: 'ai-1', amount: 40 }] });
    expect(getPokerChipPiles(snapshot(265, [0, 0, 0], 'turn'))).toEqual({ pot: 265, totalPot: 265, wagers: [] });
  });
  it('retains folded players money and exact odd-chip side-pot totals', () => {
    const state = snapshot(15003, [5001, 1001, 0], 'river');
    state.players[1].folded = true;
    expect(getPokerChipPiles(state)).toEqual({ pot: 9001, totalPot: 15003,
      wagers: [{ playerId: 'player', amount: 5001 }, { playerId: 'ai-1', amount: 1001 }] });
  });
  it('keeps showdown money visible until the settled snapshot clears the table', () => {
    expect(getPokerChipPiles(snapshot(501, [0, 0], 'showdown'))).toEqual({ pot: 501, totalPot: 501, wagers: [] });
    expect(getPokerChipPiles(snapshot(501, [20, 40], 'settled'))).toEqual({ pot: 0, totalPot: 0, wagers: [] });
  });
  it('does not mutate the authoritative snapshot', () => {
    const state = snapshot(601, [20, 40]);
    const before = structuredClone(state);
    Object.freeze(state.players[0]); Object.freeze(state.players); Object.freeze(state);
    getPokerChipPiles(state);
    expect(state).toEqual(before);
  });
  it('never emits a negative central pile from an inconsistent snapshot', () => {
    expect(getPokerChipPiles(snapshot(20, [20, 40])).pot).toBe(0);
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid money %s', amount => {
    expect(() => getPokerChipPiles(snapshot(amount, [0]))).toThrow(RangeError);
    expect(() => getPokerChipPiles(snapshot(60, [amount]))).toThrow(RangeError);
    expect(() => createChipScale([amount])).toThrow(RangeError);
    expect(() => getChipProportion(amount, createChipScale([100]))).toThrow(RangeError);
  });
  it('rejects a contribution sum that cannot be represented exactly', () => {
    expect(() => getPokerChipPiles(snapshot(Number.MAX_SAFE_INTEGER, [Number.MAX_SAFE_INTEGER, 1]))).toThrow(RangeError);
  });
  it.each([false, true])('places the central pile beside the pot amount in compact=%s', compact => {
    expect(getPotChipPilePosition(compact)).toEqual({ x: -212, y: compact ? 86 : 92 });
  });
  it.each([[667, 375], [844, 390], [1280, 720]])('keeps all six piles on the felt and clear of cards at %s×%s', (width, height) => {
    const v = getPokerViewport(width, height);
    const statusY = -v.designHeight / 2 + 12 + v.actionHeight + 22;
    const compactSeats: Record<string, { x: number; y: number }> = {
      'ai-1': { x: 0, y: v.designHeight / 2 - 105 },
      'ai-2': { x: -430, y: v.designHeight / 2 - 148 },
      'ai-3': { x: 430, y: v.designHeight / 2 - 148 },
      'ai-4': { x: 500, y: statusY + 112 },
      'ai-5': { x: -500, y: statusY + 112 },
      player: { x: 0, y: statusY + 64 },
    };
    for (const seat of getPokerSeatLayout()) {
      const position = v.compact ? compactSeats[seat.id] : seat;
      const pile = getChipPilePosition(seat.id, position, v.compact);
      expect(Math.abs(pile.x)).toBeLessThanOrEqual(420);
      expect(pile.y - 16).toBeGreaterThan(statusY + 24);
      expect(pile.y + 16).toBeLessThan(v.designHeight / 2 - 60);
      // Each pile has a clear horizontal gap from its owner's two-card spread.
      expect(Math.abs(pile.x - position.x)).toBeGreaterThanOrEqual(112);
      // The centre community cards occupy [-138,138] × [y-34,y+34].
      const communityY = v.compact ? 30 : 8;
      expect(Math.abs(pile.x) >= 166 || Math.abs(pile.y - communityY) >= 50).toBe(true);
    }
  });
});
