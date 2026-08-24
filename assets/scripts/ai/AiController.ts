import { Card, PlayerAction, Street } from '../core/types';

export interface AiContext {
  holeCards: readonly Card[];
  communityCards: readonly Card[];
  street: Street;
  pot: number;
  toCall: number;
  stack: number;
  legalActions: readonly PlayerAction[];
  random: () => number;
}

export function chooseAiAction(context: AiContext): PlayerAction {
  const byType = new Map(context.legalActions.map((action) => [action.type, action]));
  const fold = byType.get('fold');
  const check = byType.get('check');
  const call = byType.get('call');
  const raise = byType.get('raise');
  const allIn = byType.get('all-in');

  if (!check && !call && !raise && allIn) {
    return allIn;
  }

  const strength = scoreVisibleStrength(context);

  if (context.toCall === 0) {
    if (raise && strength >= 0.78 && context.random() > 0.18) {
      return raise;
    }

    return check ?? raise ?? allIn ?? fold!;
  }

  if (strength < 0.3 && fold) {
    return fold;
  }

  if (raise && strength >= 0.82 && context.random() > 0.08) {
    return raise;
  }

  if (allIn && strength >= 0.94 && context.stack <= context.pot + context.toCall) {
    return allIn;
  }

  return call ?? allIn ?? fold!;
}

function scoreVisibleStrength(context: AiContext): number {
  const [first, second] = context.holeCards;
  const high = Math.max(first.rank, second.rank);
  const low = Math.min(first.rank, second.rank);
  const paired = first.rank === second.rank;
  const suited = first.suit === second.suit;

  if (context.street === 'preflop') {
    if (paired) {
      return 0.58 + (high - 2) / 28;
    }

    const highCardScore = (high - 2) / 20;
    const gapPenalty = Math.min(Math.abs(first.rank - second.rank), 5) * 0.055;
    return Math.max(0.05, 0.16 + highCardScore + (suited ? 0.09 : 0) - gapPenalty);
  }

  const pairOnBoard = context.communityCards.some((card) => card.rank === first.rank || card.rank === second.rank);
  const connected = Math.abs(first.rank - second.rank) <= 2;
  return Math.min(0.95, 0.22 + (paired ? 0.28 : 0) + (pairOnBoard ? 0.32 : 0) + (suited ? 0.08 : 0) + (connected ? 0.08 : 0) + (high >= 13 ? 0.1 : 0));
}
