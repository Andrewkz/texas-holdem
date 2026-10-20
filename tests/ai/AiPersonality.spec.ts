import { describe, expect, it } from 'vitest';

import { createAiTableProfiles, DEFAULT_AI_PROFILE, getAiThinkDelay } from '../../assets/scripts/ai/AiPersonality';
import { PlayerAction } from '../../assets/scripts/core/types';

function seeded(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

const seatIds = ['ai-1', 'ai-2', 'ai-3', 'ai-4', 'ai-5'];
const easyDecision = {
  street: 'preflop' as const,
  toCall: 0,
  pot: 200,
  stack: 5000,
  legalActions: [{ type: 'check' }, { type: 'raise', to: 80 }] as PlayerAction[],
};

describe('AI table personalities', () => {
  it('assigns every opponent one of five distinct persistent styles without changing seat order', () => {
    const profiles = createAiTableProfiles(seatIds, seeded(7));
    expect([...profiles.keys()]).toEqual(seatIds);
    expect(new Set([...profiles.values()].map((profile) => profile.style))).toEqual(new Set([
      'tight', 'calling', 'aggressive', 'balanced', 'unpredictable',
    ]));
    const firstProfile = profiles.get('ai-1');
    getAiThinkDelay(easyDecision, firstProfile!, seeded(2));
    expect(profiles.get('ai-1')).toBe(firstProfile);
    expect(createAiTableProfiles([], seeded(7)).size).toBe(0);
  });

  it('reproduces a seeded table while different new tables shuffle who plays each style', () => {
    expect(createAiTableProfiles(seatIds, seeded(71))).toEqual(createAiTableProfiles(seatIds, seeded(71)));
    const tableOrders = new Set(Array.from({ length: 40 }, (_, index) => (
      [...createAiTableProfiles(seatIds, seeded(index + 1)).values()].map((profile) => profile.style).join(',')
    )));
    expect(tableOrders.size).toBeGreaterThan(15);
  });

  it('keeps small individual variation while preserving recognisable style differences', () => {
    const tables = Array.from({ length: 50 }, (_, index) => createAiTableProfiles(seatIds, seeded(index + 1)));
    const profiles = tables.flatMap((table) => [...table.values()]);
    for (const profile of profiles) {
      for (const field of ['aggression', 'looseness', 'bluffFrequency', 'sizingVariance'] as const) {
        expect(profile[field]).toBeGreaterThanOrEqual(0);
        expect(profile[field]).toBeLessThanOrEqual(1);
      }
      expect(profile.tempo).toBeGreaterThanOrEqual(0.85);
      expect(profile.tempo).toBeLessThanOrEqual(1.15);
    }
    for (const table of tables) {
      const byStyle = new Map([...table.values()].map((profile) => [profile.style, profile]));
      expect(byStyle.get('calling')!.looseness).toBeGreaterThan(byStyle.get('tight')!.looseness);
      expect(byStyle.get('aggressive')!.aggression).toBeGreaterThan(byStyle.get('calling')!.aggression);
      expect(byStyle.get('unpredictable')!.sizingVariance).toBeGreaterThan(byStyle.get('tight')!.sizingVariance);
    }
    expect(new Set(profiles.filter((profile) => profile.style === 'balanced').map((profile) => profile.aggression)).size).toBeGreaterThan(10);
  });
});

describe('AI thinking rhythm', () => {
  it('varies otherwise identical turns, within a short playable range', () => {
    const random = seeded(20);
    const delays = Array.from({ length: 1000 }, () => getAiThinkDelay(easyDecision, DEFAULT_AI_PROFILE, random));
    expect(new Set(delays).size).toBeGreaterThan(100);
    expect(Math.max(...delays) - Math.min(...delays)).toBeGreaterThan(0.45);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(0.35);
    expect(Math.max(...delays)).toBeLessThanOrEqual(1.8);
  });

  it('lets a pressured late street take longer without making delay depend on private strength', () => {
    const pressuredDecision = {
      ...easyDecision,
      street: 'river' as const,
      toCall: 1200,
      pot: 2000,
      legalActions: [{ type: 'fold' }, { type: 'call', amount: 1200 }] as PlayerAction[],
    };
    const easy = getAiThinkDelay(easyDecision, DEFAULT_AI_PROFILE, () => 0.5);
    const pressured = getAiThinkDelay(pressuredDecision, DEFAULT_AI_PROFILE, () => 0.5);
    expect(pressured).toBeGreaterThan(easy);
    const privateA = { ...pressuredDecision, holeCards: [{ rank: 14, suit: 'S' }], strength: 1 };
    const privateB = { ...pressuredDecision, holeCards: [{ rank: 2, suit: 'C' }], strength: 0 };
    expect(getAiThinkDelay(privateA, DEFAULT_AI_PROFILE, seeded(8))).toBe(getAiThinkDelay(privateB, DEFAULT_AI_PROFILE, seeded(8)));
  });

  it('uses individual tempo without locking one style into a fixed delay', () => {
    const fast = getAiThinkDelay(easyDecision, { ...DEFAULT_AI_PROFILE, tempo: 0.85 }, () => 0.5);
    const slow = getAiThinkDelay(easyDecision, { ...DEFAULT_AI_PROFILE, tempo: 1.15 }, () => 0.5);
    expect(slow).toBeGreaterThan(fast);
    expect(getAiThinkDelay(easyDecision, DEFAULT_AI_PROFILE, seeded(18))).not.toBe(
      getAiThinkDelay(easyDecision, DEFAULT_AI_PROFILE, seeded(19)),
    );
  });

  it.each([() => 1, () => -1, () => Number.NaN, () => Number.POSITIVE_INFINITY])('bounds both personality assignment and delay with an invalid random source', (random) => {
    const profiles = createAiTableProfiles(seatIds, random);
    expect(new Set([...profiles.values()].map((profile) => profile.style)).size).toBe(5);
    for (const profile of profiles.values()) {
      expect(profile.aggression).toBeGreaterThanOrEqual(0);
      expect(profile.aggression).toBeLessThanOrEqual(1);
      for (const context of [easyDecision, { ...easyDecision, street: 'river' as const, toCall: 5000 }]) {
        const delay = getAiThinkDelay(context, profile, random);
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0.35);
        expect(delay).toBeLessThanOrEqual(1.8);
      }
    }
  });
});
