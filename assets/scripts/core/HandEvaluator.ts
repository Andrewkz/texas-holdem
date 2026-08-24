import { Card } from './types';

export enum HandCategory {
  HighCard,
  Pair,
  TwoPair,
  Trips,
  Straight,
  Flush,
  FullHouse,
  Quads,
  StraightFlush,
}

export interface HandValue {
  category: HandCategory;
  tiebreak: number[];
  cards: Card[];
}

export function compareHands(left: HandValue, right: HandValue): number {
  if (left.category !== right.category) {
    return left.category - right.category;
  }

  const longestTiebreak = Math.max(left.tiebreak.length, right.tiebreak.length);

  for (let index = 0; index < longestTiebreak; index += 1) {
    const difference = (left.tiebreak[index] ?? 0) - (right.tiebreak[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

export function evaluateBest(cards: Card[]): HandValue {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error('Expected 5 to 7 cards');
  }

  return choose(cards, 5)
    .map(evaluateFive)
    .reduce((best, hand) => compareHands(hand, best) > 0 ? hand : best);
}

function evaluateFive(cards: Card[]): HandValue {
  const descendingRanks = cards.map((card) => card.rank).sort((left, right) => right - left);
  const counts = new Map<number, number>();

  for (const rank of descendingRanks) {
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }

  const groups = [...counts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((left, right) => right.count - left.count || right.rank - left.rank);
  const straightHigh = findStraightHigh([...counts.keys()]);
  const flush = cards.every((card) => card.suit === cards[0].suit);

  if (flush && straightHigh !== null) {
    return makeValue(HandCategory.StraightFlush, [straightHigh], cards);
  }

  if (groups[0].count === 4) {
    return makeValue(HandCategory.Quads, [groups[0].rank, groups[1].rank], cards);
  }

  if (groups[0].count === 3 && groups[1].count === 2) {
    return makeValue(HandCategory.FullHouse, [groups[0].rank, groups[1].rank], cards);
  }

  if (flush) {
    return makeValue(HandCategory.Flush, descendingRanks, cards);
  }

  if (straightHigh !== null) {
    return makeValue(HandCategory.Straight, [straightHigh], cards);
  }

  if (groups[0].count === 3) {
    return makeValue(HandCategory.Trips, [groups[0].rank, ...groups.slice(1).map(({ rank }) => rank)], cards);
  }

  if (groups[0].count === 2 && groups[1].count === 2) {
    return makeValue(HandCategory.TwoPair, [groups[0].rank, groups[1].rank, groups[2].rank], cards);
  }

  if (groups[0].count === 2) {
    return makeValue(HandCategory.Pair, [groups[0].rank, ...groups.slice(1).map(({ rank }) => rank)], cards);
  }

  return makeValue(HandCategory.HighCard, descendingRanks, cards);
}

function findStraightHigh(ranks: number[]): number | null {
  const ascending = [...ranks].sort((left, right) => left - right);

  if (ascending.length !== 5) {
    return null;
  }

  if (ascending.join(',') === '2,3,4,5,14') {
    return 5;
  }

  return ascending[4] - ascending[0] === 4 ? ascending[4] : null;
}

function makeValue(category: HandCategory, tiebreak: number[], cards: Card[]): HandValue {
  return { category, tiebreak, cards };
}

function choose<T>(items: T[], count: number): T[][] {
  if (count === 0) {
    return [[]];
  }

  if (items.length < count) {
    return [];
  }

  const [first, ...rest] = items;

  return [
    ...choose(rest, count - 1).map((combination) => [first, ...combination]),
    ...choose(rest, count),
  ];
}
