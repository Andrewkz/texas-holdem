import { describe, expect, it } from 'vitest';

import { buildPots } from '../../assets/scripts/core/SidePot';

describe('buildPots', () => {
  it('creates a main pot and nested eligible side pots', () => {
    expect(buildPots([
      { playerId: 'a', amount: 100, folded: false },
      { playerId: 'b', amount: 200, folded: false },
      { playerId: 'c', amount: 300, folded: false },
      { playerId: 'd', amount: 300, folded: true },
    ])).toEqual([
      { amount: 400, eligiblePlayerIds: ['a', 'b', 'c'] },
      { amount: 300, eligiblePlayerIds: ['b', 'c'] },
      { amount: 200, eligiblePlayerIds: ['c'] },
    ]);
  });
});
