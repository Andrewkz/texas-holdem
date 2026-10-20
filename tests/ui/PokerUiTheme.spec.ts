import { describe, expect, it } from 'vitest';

import {
  POKER_RAISE_MODAL,
  POKER_SHOWDOWN_FEEDBACK,
  POKER_UI,
  getActionButtonSpecs,
  getPokerSeatLayout,
} from '../../assets/scripts/ui/PokerUiTheme';

describe('PokerUiTheme', () => {
  it('keeps the Pen design palette and a six-seat 1280×720 layout', () => {
    expect(POKER_UI.canvas).toEqual({ width: 1280, height: 720 });
    expect(POKER_UI.colors.background).toBe('#10191D');
    expect(POKER_UI.colors.gold).toBe('#D6B575');
    expect(getPokerSeatLayout()).toEqual([
      { id: 'ai-1', x: 0, y: 258, name: '山雀' },
      { id: 'ai-3', x: 420, y: 168, name: 'Marco' },
      { id: 'ai-4', x: 486, y: -100, name: 'Nova' },
      { id: 'player', x: 0, y: -214, name: '你 · VIP' },
      { id: 'ai-5', x: -486, y: -100, name: '夜航' },
      { id: 'ai-2', x: -420, y: 168, name: 'Luna' },
    ]);
  });

  it('enumerates seats clockwise according to their actual table coordinates', () => {
    const seats = getPokerSeatLayout();
    const angle = (seat: { x: number; y: number }) => (Math.atan2(seat.x, seat.y) + 2 * Math.PI) % (2 * Math.PI);
    const clockwise = seats.slice().sort((left, right) => angle(left) - angle(right));
    expect(seats.map(seat => seat.id)).toEqual(clockwise.map(seat => seat.id));
  });

  it('keeps the four gameplay actions in the Pen visual order', () => {
    expect(getActionButtonSpecs()).toEqual([
      { action: 'fold', color: '#293638' },
      { action: 'call', color: '#245C50' },
      { action: 'raise', color: '#D6B575' },
      { action: 'all-in', color: '#553C31' },
    ]);
  });

  it('centers the raise dialog with room for amount guidance', () => {
    expect(POKER_RAISE_MODAL).toEqual({ width: 660, height: 360, y: 0 });
  });

  it('uses a gold highlight and timed pot return for showdown feedback', () => {
    expect(POKER_SHOWDOWN_FEEDBACK).toEqual({ winnerScale: 1.04, chipDuration: 0.18 });
  });
});
