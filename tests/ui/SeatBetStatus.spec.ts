import { describe, expect, it } from 'vitest';
import type { PlayerSnapshot } from '../../assets/scripts/core/types';
import { getSeatBetStatus } from '../../assets/scripts/ui/SeatBetStatus';

function player(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return { id: 'p', name: 'Player', stack: 5000, folded: false, allIn: false,
    streetContribution: 0, totalContribution: 0, ...overrides };
}

describe('getSeatBetStatus', () => {
  it('keeps folded status above a stale action, all-in flag, or thinking indicator', () => {
    expect(getSeatBetStatus(player({ folded: true, allIn: true, streetContribution: 40 }),
      { type: 'raise', to: 200 }, true)).toEqual({ text: '已弃牌', tone: 'fold', committed: 40 });
  });

  it('keeps an all-in flag visible while thinking and after a different action', () => {
    expect(getSeatBetStatus(player({ allIn: true, streetContribution: 5000 }),
      { type: 'call', amount: 20 }, true)).toEqual({ text: '已全压', tone: 'all-in', committed: 5000 });
  });

  it('replaces the previous action with thinking for the active player', () => {
    expect(getSeatBetStatus(player({ streetContribution: 40 }), { type: 'call', amount: 40 }, true))
      .toEqual({ text: '思考中', tone: 'thinking', committed: 40 });
  });

  it.each([
    [{ type: 'fold' } as const, '已弃牌', 'fold'],
    [{ type: 'all-in' } as const, '已全压', 'all-in'],
    [{ type: 'raise', to: 120 } as const, '已加注', 'raise'],
    [{ type: 'call', amount: 20 } as const, '跟注', 'call'],
    [{ type: 'check' } as const, '已过牌', 'check'],
  ])('shows action %s without duplicating its amount in the status', (action, text, tone) => {
    expect(getSeatBetStatus(player({ streetContribution: 120 }), action))
      .toEqual({ text, tone, committed: 120 });
  });

  it('uses authoritative current contribution instead of call increment or raise target', () => {
    expect(getSeatBetStatus(player({ streetContribution: 120 }), { type: 'call', amount: 20 }).committed).toBe(120);
    expect(getSeatBetStatus(player({ streetContribution: 40 }), { type: 'raise', to: 120 }).committed).toBe(40);
  });

  it('labels a posted blind or other contribution without inventing a blind role', () => {
    expect(getSeatBetStatus(player({ streetContribution: 40 }), null))
      .toEqual({ text: '已下注', tone: 'bet', committed: 40 });
  });

  it('does not turn an earlier street contribution into a new wager', () => {
    expect(getSeatBetStatus(player({ totalContribution: 400 }), null))
      .toEqual({ text: '待行动', tone: 'waiting', committed: 0 });
  });

  it('preserves exact large and zero amounts without abbreviated or inferred values', () => {
    expect(getSeatBetStatus(player({ streetContribution: Number.MAX_SAFE_INTEGER }), null).committed)
      .toBe(Number.MAX_SAFE_INTEGER);
    expect(getSeatBetStatus(player(), { type: 'check' }).committed).toBe(0);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined])(
    'rejects invalid current contribution %s instead of fabricating a wager', amount => {
      expect(() => getSeatBetStatus(player({ streetContribution: amount as number }), null)).toThrow(RangeError);
    },
  );

  it('does not mutate or retain a previous snapshot or action', () => {
    const state = Object.freeze(player({ streetContribution: 80 }));
    const action = Object.freeze({ type: 'raise', to: 80 } as const);
    expect(getSeatBetStatus(state, action).tone).toBe('raise');
    expect(getSeatBetStatus(player(), null)).toEqual({ text: '待行动', tone: 'waiting', committed: 0 });
    expect(state.streetContribution).toBe(80);
    expect(action.to).toBe(80);
  });
});
