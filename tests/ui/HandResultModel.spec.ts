import { describe, expect, it } from 'vitest';
import { buildHandResult } from '../../assets/scripts/ui/HandResultModel';

const players = [{ id: 'me', name: '完整的玩家昵称' }, { id: 'other', name: '另一位玩家' }];

describe('per-hand payout summaries', () => {
  it('combines multiple awards per winner without dropping another winner or changing full names', () => {
    const result = buildHandResult(8, [
      { playerId: 'me', amount: 300, handName: '两对' },
      { playerId: 'other', amount: 300, handName: '两对' },
      { playerId: 'me', amount: 500, handName: '两对' },
    ], players, 'me', -200);
    expect(result.winners).toEqual([
      { playerId: 'me', name: '完整的玩家昵称', amount: 800, handNames: ['两对'], isSelf: true },
      { playerId: 'other', name: '另一位玩家', amount: 300, handNames: ['两对'], isSelf: false },
    ]);
    expect(result.totalAwarded).toBe(1100);
    expect(result.selfPayout).toBe(800);
    expect(result.selfNet).toBe(-200);
    expect(result.awardCount).toBe(3);
  });

  it('does not equate a payout with profit or invent a missing net result', () => {
    const result = buildHandResult(9, [{ playerId: 'other', amount: 100, handName: '未摊牌' }], players, 'me');
    expect(result.selfPayout).toBe(0);
    expect(result.selfNet).toBeUndefined();
    expect(result.totalAwarded).toBe(100);
  });

  it('ignores invalid payouts and keeps an unknown winner identifiable', () => {
    const result = buildHandResult(9, [
      { playerId: 'gone', amount: 25, handName: '高牌' },
      { playerId: 'other', amount: -5, handName: '高牌' },
      { playerId: 'other', amount: Number.NaN, handName: '高牌' },
      { playerId: 'other', amount: 1.5, handName: '高牌' },
    ], players, 'me', Number.NaN);
    expect(result.winners).toEqual([{ playerId: 'gone', name: 'gone', amount: 25, handNames: ['高牌'], isSelf: false }]);
    expect(result.totalAwarded).toBe(25);
    expect(result.selfNet).toBeUndefined();
  });
});
