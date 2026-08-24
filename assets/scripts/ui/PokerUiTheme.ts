export const POKER_UI = {
  canvas: { width: 1280, height: 720 },
  colors: {
    background: '#0B162B',
    panel: '#182C47',
    panelRaised: '#14304A',
    felt: '#217E5E',
    gold: '#F5C051',
    text: '#F0F9FF',
  },
  radii: { panel: 18, seat: 16, control: 8, card: 6 },
  actionColors: ['#AC3D49', '#2E699C', '#198E63', '#C67D24'],
} as const;

export const POKER_RAISE_MODAL = { width: 620, height: 196, y: -128 } as const;
export const POKER_SHOWDOWN_FEEDBACK = { winnerScale: 1.06, chipDuration: 0.24 } as const;

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
  return [
    { id: 'ai-1', x: 0, y: 258, name: '山雀' },
    { id: 'ai-2', x: -420, y: 168, name: 'Luna' },
    { id: 'ai-3', x: 420, y: 168, name: 'Marco' },
    { id: 'ai-4', x: 486, y: -100, name: 'Nova' },
    { id: 'ai-5', x: -486, y: -100, name: '夜航' },
    { id: 'player', x: 0, y: -214, name: '你 · VIP' },
  ];
}
