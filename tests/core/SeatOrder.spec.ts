import { describe, expect, it } from 'vitest';

import { CLOCKWISE_SEAT_IDS, clockwiseSeatIdsFrom } from '../../assets/scripts/core/SeatOrder';
import { getPokerSeatLayout } from '../../assets/scripts/ui/PokerUiTheme';

describe('physical clockwise seat order', () => {
  it('follows the rendered coordinates clockwise from the top seat', () => {
    const byAngle = getPokerSeatLayout()
      .sort((a, b) => ((Math.atan2(a.x, a.y) + 2 * Math.PI) % (2 * Math.PI))
        - ((Math.atan2(b.x, b.y) + 2 * Math.PI) % (2 * Math.PI)))
      .map(({ id }) => id);
    expect(CLOCKWISE_SEAT_IDS).toEqual(byAngle);
  });

  it('rotates clockwise to any physical seat without changing the canonical order', () => {
    const before = Array.from(CLOCKWISE_SEAT_IDS);
    expect(clockwiseSeatIdsFrom('player')).toEqual(['player', 'ai-5', 'ai-2', 'ai-1', 'ai-3', 'ai-4']);
    expect(clockwiseSeatIdsFrom('ai-4')).toEqual(['ai-4', 'player', 'ai-5', 'ai-2', 'ai-1', 'ai-3']);
    expect(clockwiseSeatIdsFrom('ai-1')).toEqual(before);
    expect(CLOCKWISE_SEAT_IDS).toEqual(before);
  });

  it('rejects unknown seats instead of silently producing a different order', () => {
    expect(() => clockwiseSeatIdsFrom('missing-seat')).toThrow('Unknown seat');
    expect(() => clockwiseSeatIdsFrom('')).toThrow('Unknown seat');
  });
});
