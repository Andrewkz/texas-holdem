import type { PlayerAction, PlayerSnapshot } from '../core/types';

export interface SeatBetStatus {
  text: string;
  tone: 'fold' | 'all-in' | 'raise' | 'call' | 'check' | 'thinking' | 'bet' | 'waiting';
  /** Exact current-street contribution; action increments are not total commitments. */
  committed: number;
}

/** Derives the badge from this render's state, without retaining earlier streets or hands. */
export function getSeatBetStatus(
  player: Pick<PlayerSnapshot, 'folded' | 'allIn' | 'streetContribution' | 'totalContribution'>,
  action: PlayerAction | null,
  thinking = false,
): SeatBetStatus {
  const committed = player.streetContribution;
  if (!Number.isSafeInteger(committed) || committed < 0) {
    throw new RangeError('Seat contribution must be a non-negative safe integer');
  }
  if (player.folded) return { text: '已弃牌', tone: 'fold', committed };
  if (player.allIn) return { text: '已全压', tone: 'all-in', committed };
  if (thinking) return { text: '思考中', tone: 'thinking', committed };
  switch (action?.type) {
    case 'fold': return { text: '已弃牌', tone: 'fold', committed };
    case 'all-in': return { text: '已全压', tone: 'all-in', committed };
    case 'raise': return { text: '已加注', tone: 'raise', committed };
    case 'call': return { text: '跟注', tone: 'call', committed };
    case 'check': return { text: '已过牌', tone: 'check', committed };
    default: return committed > 0
      ? { text: '已下注', tone: 'bet', committed }
      : { text: '待行动', tone: 'waiting', committed };
  }
}
