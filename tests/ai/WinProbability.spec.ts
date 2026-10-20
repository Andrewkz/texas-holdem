import { describe, expect, it, vi } from 'vitest';

import { createWinProbabilityTask } from '../../assets/scripts/ai/WinProbability';
import { Card } from '../../assets/scripts/core/types';

function cards(text: string): Card[] {
  return text ? text.split(' ').map(code => ({
    rank: Number(code.slice(0, -1)) as Card['rank'],
    suit: code.slice(-1) as Card['suit'],
  })) : [];
}

function estimate(hole: string, board = '', opponentCount = 1, samples = 500, seed = 14245) {
  const task = createWinProbabilityTask({
    holeCards: cards(hole), communityCards: cards(board), opponentCount,
  }, { samples, seed });
  while (!task.result.done) task.step(8);
  return task.result;
}

describe('single-player visible-card win probability', () => {
  it('always splits a public royal flush among every remaining player', () => {
    for (const opponents of [1, 3, 5]) {
      const result = estimate('2C 7D', '10H 11H 12H 13H 14H', opponents, 32);
      expect(result.trials).toBe(32);
      expect(result.winProbability).toBe(0);
      expect(result.tieProbability).toBe(1);
      expect(result.equity).toBeCloseTo(1 / (opponents + 1), 12);
    }
  });

  it('always wins with a private royal flush on a completed board', () => {
    const result = estimate('14H 13H', '10H 11H 12H 2C 3D', 5, 32);
    expect(result.winProbability).toBe(1);
    expect(result.tieProbability).toBe(0);
    expect(result.equity).toBe(1);
  });

  it('gives plausible heads-up preflop estimates and lowers equity against more opponents', () => {
    const aces = estimate('14H 14S', '', 1, 700);
    const weak = estimate('7H 2C', '', 1, 700);
    const multiway = estimate('14H 14S', '', 5, 700);
    expect(aces.equity).toBeGreaterThan(0.79);
    expect(aces.equity).toBeLessThan(0.91);
    expect(weak.equity).toBeGreaterThan(0.28);
    expect(weak.equity).toBeLessThan(0.42);
    expect(multiway.equity).toBeLessThan(aces.equity - 0.2);
  });

  it('reproduces the same trials independently of batch size and never calls global random', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw Error('global RNG used'); });
    try {
      const input = { holeCards: cards('14S 12S'), communityCards: cards('2H 8S 11S'), opponentCount: 2 };
      const one = createWinProbabilityTask(input, { samples: 71, seed: 0 });
      const many = createWinProbabilityTask(input, { samples: 71, seed: 0 });
      while (!one.result.done) one.step(1);
      while (!many.result.done) many.step(8);
      expect(one.result).toEqual(many.result);
      expect(one.result.trials).toBe(71);
    } finally { random.mockRestore(); }
  });

  it('supports cancellation without any further work or changed estimates', () => {
    const task = createWinProbabilityTask({ holeCards: cards('14S 12S'), communityCards: [], opponentCount: 2 });
    expect(task.result.trials).toBe(0);
    expect(task.result.done).toBe(false);
    expect(task.step(8).trials).toBe(8);
    task.cancel();
    const result = task.result;
    expect(result.cancelled).toBe(true);
    expect(result.done).toBe(true);
    expect(task.step(8)).toEqual(result);
  });

  it('keeps input cards immutable and samples independent completions on turn and flop', () => {
    const input = Object.freeze({
      holeCards: Object.freeze(cards('14H 8H').map(Object.freeze)),
      communityCards: Object.freeze(cards('2H 7H 11S 5C').map(Object.freeze)), opponentCount: 3,
    });
    const task = createWinProbabilityTask(input, { samples: 35, seed: 987 });
    const before = JSON.stringify(input);
    const result = task.step(100);
    expect(result.trials).toBe(35);
    expect(JSON.stringify(input)).toBe(before);
    expect(result.winProbability + result.tieProbability).toBeLessThanOrEqual(1);
    expect(result.equity).toBeGreaterThanOrEqual(result.winProbability);
    expect(result.equity).toBeLessThanOrEqual(result.winProbability + result.tieProbability);
    expect(estimate('14H 8H', '2H 7H 11S', 3, 35).trials).toBe(35);
  });

  it('rejects duplicate, invalid or impossible public inputs and invalid work limits', () => {
    const valid = { holeCards: cards('14S 12S'), communityCards: [], opponentCount: 1 };
    for (const holeCards of [[], cards('14S'), cards('14S 14S'), cards('15S 12S'), cards('14X 12S')]) {
      expect(() => createWinProbabilityTask({ ...valid, holeCards })).toThrow();
    }
    for (const communityCards of [cards('2H'), cards('2H 3D'), cards('2H 3D 14S'), cards('2H 3D 4C 5H 6S 7D')]) {
      expect(() => createWinProbabilityTask({ ...valid, communityCards })).toThrow();
    }
    for (const opponentCount of [0, 6, -1, 1.5, NaN, Infinity]) {
      expect(() => createWinProbabilityTask({ ...valid, opponentCount })).toThrow();
    }
    for (const samples of [0, -1, 1.5, NaN, Infinity, 100001]) {
      expect(() => createWinProbabilityTask(valid, { samples })).toThrow();
    }
    for (const seed of [NaN, Infinity, 1.5]) {
      expect(() => createWinProbabilityTask(valid, { seed })).toThrow();
    }
    const task = createWinProbabilityTask(valid);
    for (const batch of [0, -1, 1.5, NaN, Infinity]) expect(() => task.step(batch)).toThrow();
  });
});
