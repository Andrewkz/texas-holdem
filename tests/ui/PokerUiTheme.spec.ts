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
    expect(POKER_UI.colors.background).toBe('#0B162B');
    expect(POKER_UI.colors.gold).toBe('#F5C051');
    expect(getPokerSeatLayout()).toEqual([
      { id: 'ai-1', x: 0, y: 258, name: '山雀' },
      { id: 'ai-2', x: -420, y: 168, name: 'Luna' },
      { id: 'ai-3', x: 420, y: 168, name: 'Marco' },
      { id: 'ai-4', x: 486, y: -100, name: 'Nova' },
      { id: 'ai-5', x: -486, y: -100, name: '夜航' },
      { id: 'player', x: 0, y: -214, name: '你 · VIP' },
    ]);
  });

  it('keeps the four gameplay actions in the Pen visual order', () => {
    expect(getActionButtonSpecs()).toEqual([
      { action: 'fold', color: '#AC3D49' },
      { action: 'call', color: '#2E699C' },
      { action: 'raise', color: '#198E63' },
      { action: 'all-in', color: '#C67D24' },
    ]);
  });

  it('uses the Pen custom raise modal geometry', () => {
    expect(POKER_RAISE_MODAL).toEqual({ width: 620, height: 196, y: -128 });
  });

  it('uses a gold highlight and timed pot return for showdown feedback', () => {
    expect(POKER_SHOWDOWN_FEEDBACK).toEqual({ winnerScale: 1.06, chipDuration: 0.24 });
  });
});
