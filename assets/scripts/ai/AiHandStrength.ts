import { Card, Street } from '../core/types';
import { compareHands, evaluateBest, HandCategory, HandValue } from '../core/HandEvaluator';

export interface VisibleHandAssessment {
  madeStrength: number;
  drawPotential: number;
  boardOnly: boolean;
  sharedNuts: boolean;
}

export function assessVisibleHand(
  holeCards: readonly Card[], communityCards: readonly Card[], street: Street,
): VisibleHandAssessment {
  // These are bounded decision heuristics, not measured equity or an opponent-card model.
  if (street === 'preflop' || communityCards.length < 3) {
    return { madeStrength: preflopStrength(holeCards), drawPotential: 0, boardOnly: false, sharedNuts: false };
  }

  const visibleCards = [...holeCards, ...communityCards];
  const best = evaluateBest(visibleCards);
  const boardHand = communityCards.length === 5 ? evaluateBest([...communityCards]) : null;
  const boardOnly = boardHand !== null && compareHands(best, boardHand) === 0;
  // Only certify this absolute nut board; other shared hands can still lose to an improvement.
  const sharedNuts = street === 'river' && boardOnly
    && boardHand?.category === HandCategory.StraightFlush && boardHand.tiebreak[0] === 14;
  const madeStrength = boardOnly ? 0.34 : postflopStrength(best, holeCards, communityCards);
  const drawPotential = street === 'flop' || street === 'turn'
    ? assessDraws(holeCards, communityCards, best.category) : 0;
  return { madeStrength: clamp(madeStrength), drawPotential, boardOnly, sharedNuts };
}

function preflopStrength(holeCards: readonly Card[]): number {
  if (holeCards.length !== 2) return 0;
  const [first, second] = holeCards;
  const high = Math.max(first.rank, second.rank);
  const low = Math.min(first.rank, second.rank);
  if (high === low) return clamp(0.48 + (high - 2) * 0.039);
  // A2/A3 are adjacent at the wheel end, while still retaining their ace-high value.
  const gap = Math.min(high - low, high === 14 ? Math.abs(low - 1) : high - low);
  return clamp(0.14 + (high - 2) * 0.023 + (low - 2) * 0.015
    + (first.suit === second.suit ? 0.065 : 0)
    + (gap === 1 ? 0.065 : gap === 2 ? 0.035 : 0)
    - Math.max(0, Math.min(gap, 6) - 2) * 0.028);
}

function postflopStrength(best: HandValue, holeCards: readonly Card[], board: readonly Card[]): number {
  const boardCounts = countRanks(board);
  const ownRanks = new Set<number>(holeCards.map(card => card.rank));
  const highOwn = Math.max(...holeCards.map(card => card.rank));
  const kickerStrength = (highOwn - 2) / 12;
  const boardRanks = Array.from(boardCounts.keys()).sort((left, right) => right - left);

  switch (best.category) {
    case HandCategory.HighCard:
      return 0.12 + kickerStrength * 0.18;
    case HandCategory.Pair: {
      const pairRank = best.tiebreak[0];
      // K K x belongs to everyone; merely holding an unrelated kicker is not top pair.
      if (!ownRanks.has(pairRank)) return 0.14 + kickerStrength * 0.19;
      const higherBoardRanks = boardRanks.filter(rank => rank > pairRank).length;
      const pairStrength = higherBoardRanks === 0 ? 0.64
        : higherBoardRanks === 1 ? 0.5 : 0.38;
      const overpair = holeCards[0].rank === holeCards[1].rank && pairRank > boardRanks[0];
      const kicker = holeCards.find(card => card.rank !== pairRank)?.rank ?? 2;
      return pairStrength + (overpair ? 0.06 : (kicker - 2) / 12 * 0.035);
    }
    case HandCategory.TwoPair: {
      const privatePairs = best.tiebreak.slice(0, 2).filter(rank => ownRanks.has(rank));
      return privatePairs.length === 0 ? 0.22 + kickerStrength * 0.15
        : privatePairs.length === 1 ? 0.65 : 0.75;
    }
    case HandCategory.Trips:
      return ownRanks.has(best.tiebreak[0])
        ? (holeCards[0].rank === holeCards[1].rank ? 0.84 : 0.79)
        : 0.23 + kickerStrength * 0.18;
    case HandCategory.Straight:
      return 0.85 + (best.tiebreak[0] - 5) / 9 * 0.035;
    case HandCategory.Flush: {
      const flushSuit = best.cards[0].suit;
      const suitedOwn = holeCards.filter(card => card.suit === flushSuit);
      const boardSuitCount = board.filter(card => card.suit === flushSuit).length;
      // A deuce completing four public hearts is much less comfortable than a private nut flush.
      const ownHigh = Math.max(2, ...suitedOwn.map(card => card.rank));
      return boardSuitCount >= 4 ? 0.74 + (ownHigh - 2) / 12 * 0.19
        : 0.89 + (ownHigh - 2) / 12 * 0.04;
    }
    case HandCategory.FullHouse:
      return (boardCounts.get(best.tiebreak[0]) ?? 0) >= 3
        ? 0.82 + (best.tiebreak[1] - 2) / 12 * 0.12 : 0.94;
    case HandCategory.Quads:
      return (boardCounts.get(best.tiebreak[0]) ?? 0) === 4
        ? 0.44 + (best.tiebreak[1] - 2) / 12 * 0.5 : 0.97;
    case HandCategory.StraightFlush:
      return 0.99;
  }
}

function assessDraws(holeCards: readonly Card[], board: readonly Card[], category: HandCategory): number {
  const visibleCards = [...holeCards, ...board];
  let flushDraw = 0;
  if (category < HandCategory.Flush) {
    for (const suit of ['S', 'H', 'D', 'C'] as const) {
      if (visibleCards.filter(card => card.suit === suit).length === 4
        && holeCards.some(card => card.suit === suit)) flushDraw = 0.22;
    }
  }

  let straightDraw = 0;
  if (category < HandCategory.Straight) {
    const ranks = new Set<number>(visibleCards.map(card => card.rank));
    const boardRanks = new Set<number>(board.map(card => card.rank));
    if (ranks.has(14)) ranks.add(1);
    if (boardRanks.has(14)) boardRanks.add(1);
    const completions = new Set<number>();
    for (let low = 1; low <= 10; low += 1) {
      const window = Array.from({ length: 5 }, (_, index) => low + index);
      const missing = window.filter(rank => !ranks.has(rank));
      const privatelyContributed = window.some(rank => ranks.has(rank) && !boardRanks.has(rank));
      if (missing.length === 1 && privatelyContributed) completions.add(missing[0] === 1 ? 14 : missing[0]);
    }
    straightDraw = completions.size >= 2 ? 0.2 : completions.size === 1 ? 0.1 : 0;
  }
  // A combined draw receives a bounded bonus rather than summing into a made monster.
  return Math.min(0.32, Math.max(flushDraw, straightDraw) + Math.min(flushDraw, straightDraw) * 0.45);
}

function countRanks(cards: readonly Card[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  return counts;
}

function clamp(value: number): number { return Math.min(1, Math.max(0, value)); }
