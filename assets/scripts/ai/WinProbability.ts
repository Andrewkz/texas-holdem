import { compareHands, evaluateBest } from '../core/HandEvaluator';
import { Card, RANKS, SUITS } from '../core/types';

/** Only information visible to the human player may enter this estimator. */
export interface WinProbabilityInput {
  readonly holeCards: readonly Card[];
  readonly communityCards: readonly Card[];
  readonly opponentCount: number;
}

export interface WinProbabilityOptions {
  readonly samples?: number;
  /** A private, deterministic RNG stream; never consumes the game's randomness. */
  readonly seed?: number;
}

export interface WinProbabilityResult {
  readonly trials: number;
  /** Outright wins, excluding shared best hands. */
  readonly winProbability: number;
  /** Ties for the best hand, excluding ties between losing hands. */
  readonly tieProbability: number;
  /** Expected share of one equally contested pot, including split pots. */
  readonly equity: number;
  readonly done: boolean;
  readonly cancelled: boolean;
}

export interface WinProbabilityTask {
  readonly result: WinProbabilityResult;
  /** Execute a small batch, then let the caller yield to rendering/input. */
  step(batchSize?: number): WinProbabilityResult;
  cancel(): void;
}

/**
 * Monte Carlo estimate against uniformly random unknown opponent cards.
 * It does not model ranges, future folds, betting, side pots, or known AI hands.
 * All card assignments in a trial are drawn without replacement.
 */
export function createWinProbabilityTask(
  input: WinProbabilityInput,
  options: WinProbabilityOptions = {},
): WinProbabilityTask {
  const samples = options.samples ?? 1000;
  const seed = options.seed ?? 0x71c3a95d;
  requireInteger(samples, 1, 100000, 'samples');
  if (!Number.isFinite(seed) || !Number.isInteger(seed)) throw new RangeError('seed must be a finite integer');
  requireInteger(input.opponentCount, 1, 5, 'opponentCount');
  if (input.holeCards.length !== 2) throw new RangeError('Expected exactly two own hole cards');
  if ([0, 3, 4, 5].indexOf(input.communityCards.length) < 0) {
    throw new RangeError('Expected zero, three, four or five public cards');
  }

  const known = new Set<string>();
  const copyKnown = (card: Card): Card => {
    if (!card || SUITS.indexOf(card.suit) < 0 || RANKS.indexOf(card.rank) < 0) throw new RangeError('Invalid card');
    const key = `${card.suit}:${card.rank}`;
    if (known.has(key)) throw new RangeError('Duplicate known card');
    known.add(key);
    return { suit: card.suit, rank: card.rank };
  };
  const holeCards = input.holeCards.map(copyKnown);
  const communityCards = input.communityCards.map(copyKnown);
  const opponentCount = input.opponentCount;
  const unknown: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      if (!known.has(`${suit}:${rank}`)) unknown.push({ suit, rank });
    }
  }

  let randomState = seed >>> 0;
  // Mulberry32, always finite and within [0, 1), including seed zero.
  const random = (): number => {
    randomState = (randomState + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  let trials = 0;
  let wins = 0;
  let ties = 0;
  let shares = 0;
  let cancelled = false;
  const snapshot = (): WinProbabilityResult => ({
    trials,
    winProbability: trials ? wins / trials : 0,
    tieProbability: trials ? ties / trials : 0,
    equity: trials ? shares / trials : 0,
    done: cancelled || trials === samples,
    cancelled,
  });

  const runTrial = (): void => {
    const remaining = unknown.slice();
    let drawn = 0;
    const draw = (): Card => {
      const selected = drawn + Math.floor(random() * (remaining.length - drawn));
      const card = remaining[selected];
      remaining[selected] = remaining[drawn];
      remaining[drawn] = card;
      drawn += 1;
      return card;
    };
    const board = communityCards.slice();
    while (board.length < 5) board.push(draw());
    const ownValue = evaluateBest(holeCards.concat(board));
    let tiedOpponents = 0;
    let beaten = false;
    for (let opponent = 0; opponent < opponentCount; opponent += 1) {
      const otherValue = evaluateBest([draw(), draw()].concat(board));
      const comparison = compareHands(otherValue, ownValue);
      if (comparison > 0) {
        beaten = true;
        break;
      }
      if (comparison === 0) tiedOpponents += 1;
    }
    trials += 1;
    if (!beaten) {
      if (tiedOpponents === 0) wins += 1;
      else ties += 1;
      shares += 1 / (tiedOpponents + 1);
    }
  };

  return {
    get result() { return snapshot(); },
    step(batchSize = 8) {
      requireInteger(batchSize, 1, 100000, 'batchSize');
      if (!cancelled) {
        const until = Math.min(samples, trials + batchSize);
        while (trials < until) runTrial();
      }
      return snapshot();
    },
    cancel() { cancelled = true; },
  };
}

function requireInteger(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
}
