import { CLOCKWISE_SEAT_IDS } from '../core/SeatOrder';

export const POKER_UI = {
  canvas: { width: 1280, height: 720 },
  colors: {
    background: '#10191D',
    panel: '#18272B',
    panelRaised: '#22363A',
    felt: '#153E35',
    gold: '#D6B575',
    text: '#F2EFE7',
  },
  radii: { panel: 16, seat: 12, control: 8, card: 5 },
  actionColors: ['#293638', '#245C50', '#D6B575', '#553C31'],
} as const;

export const POKER_RAISE_MODAL = { width: 660, height: 360, y: 0 } as const;
export const POKER_SHOWDOWN_FEEDBACK = { winnerScale: 1.04, chipDuration: 0.18 } as const;

export interface PokerSeatLayout {
  id: string;
  x: number;
  y: number;
  name: string;
}

export function getActionButtonSpecs() {
  return [
    { action: 'fold', color: POKER_UI.actionColors[0] },
    { action: 'call', color: POKER_UI.actionColors[1] },
    { action: 'raise', color: POKER_UI.actionColors[2] },
    { action: 'all-in', color: POKER_UI.actionColors[3] },
  ] as const;
}

export function getPokerSeatLayout(): PokerSeatLayout[] {
  const seats: PokerSeatLayout[] = [
    { id: 'ai-1', x: 0, y: 258, name: '山雀' },
    { id: 'ai-2', x: -420, y: 168, name: 'Luna' },
    { id: 'ai-3', x: 420, y: 168, name: 'Marco' },
    { id: 'ai-4', x: 486, y: -100, name: 'Nova' },
    { id: 'ai-5', x: -486, y: -100, name: '夜航' },
    { id: 'player', x: 0, y: -214, name: '你 · VIP' },
  ];
  return CLOCKWISE_SEAT_IDS.map(id => seats.find(seat => seat.id === id)!);
}
