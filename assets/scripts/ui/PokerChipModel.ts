import type { EngineSnapshot } from '../core/types';

export interface PokerChipPiles {
  /** Previous streets, with this street's visible wagers excluded. */
  pot: number;
  /** The authoritative full pot amount, including visible wagers. */
  totalPot: number;
  wagers: Array<{ playerId: string; amount: number }>;
}

export interface ChipPilePosition { x: number; y: number }

/** Every visible pot and wager on one table uses the same amount per layer. */
export interface ChipScale { maxAmount: number; unitAmount: number; maxVisuals: number }
export interface ChipProportion {
  ratio: number;
  units: number;
  whole: number;
  fraction: number;
  visibleCount: number;
}

export const MAX_CHIP_VISUALS = 12;

export function createChipScale(amounts: readonly number[]): ChipScale {
  let maxAmount = 0;
  for (const amount of amounts) {
    assertChipAmount(amount);
    maxAmount = Math.max(maxAmount, amount);
  }
  return Object.freeze({ maxAmount, unitAmount: maxAmount / MAX_CHIP_VISUALS, maxVisuals: MAX_CHIP_VISUALS });
}

/** Fractional layers keep 200 visually twice 100 even when a larger pile sets the scale. */
export function getChipProportion(amount: number, scale: ChipScale): ChipProportion {
  assertChipAmount(amount);
  if (!scale || scale.maxVisuals !== MAX_CHIP_VISUALS) throw new RangeError('Invalid chip scale');
  assertChipAmount(scale.maxAmount);
  if (scale.unitAmount !== scale.maxAmount / MAX_CHIP_VISUALS || amount > scale.maxAmount) {
    throw new RangeError('Chip scale must cover the amount and use a consistent unit');
  }
  if (amount === 0) return { ratio: 0, units: 0, whole: 0, fraction: 0, visibleCount: 0 };
  const ratio = amount / scale.maxAmount;
  let units = ratio * MAX_CHIP_VISUALS;
  const nearest = Math.round(units);
  // Only correct floating-point noise near positive integers; tiny real piles stay visible.
  const tolerance = Number.EPSILON * 8 * Math.max(1, units);
  if (nearest > 0 && Math.abs(units - nearest) <= tolerance) units = nearest;
  const whole = Math.floor(units);
  const fraction = units - whole;
  return { ratio, units, whole, fraction, visibleCount: whole + (fraction > 0 ? 1 : 0) };
}

/** Splits the visual money locations without adding any money to the snapshot. */
export function getPokerChipPiles(snapshot: Pick<EngineSnapshot, 'street' | 'pot' | 'players'>): PokerChipPiles {
  if (snapshot.street === 'settled') return { pot: 0, totalPot: 0, wagers: [] };
  assertChipAmount(snapshot.pot);
  const wagers: PokerChipPiles['wagers'] = [];
  let currentStreet = 0;
  for (const player of snapshot.players) {
    assertChipAmount(player.streetContribution);
    currentStreet += player.streetContribution;
    assertChipAmount(currentStreet);
    if (player.streetContribution > 0) wagers.push({ playerId: player.id, amount: player.streetContribution });
  }
  return { pot: Math.max(0, snapshot.pot - currentStreet), totalPot: snapshot.pot, wagers };
}

/** Table coordinates leave the two-card spreads, avatar clocks and action bar clear. */
export function getChipPilePosition(playerId: string, seat: ChipPilePosition, compact: boolean): ChipPilePosition {
  switch (playerId) {
    case 'ai-1': return compact ? { x: seat.x + 180, y: seat.y - 115 } : { x: seat.x + 112, y: seat.y - 56 };
    case 'ai-2': return { x: seat.x + 158, y: seat.y - 4 };
    case 'ai-3': return { x: seat.x - 158, y: seat.y - 4 };
    case 'ai-4': return { x: seat.x - 150, y: seat.y - 8 };
    case 'ai-5': return { x: seat.x + 150, y: seat.y - 8 };
    default: return { x: seat.x + 112, y: seat.y + (compact ? 98 : 82) };
  }
}

export function getPotChipPilePosition(compact: boolean, shortTable = false): ChipPilePosition {
  return compact && shortTable ? { x: -330, y: 30 } : { x: -212, y: compact ? 86 : 92 };
}

function assertChipAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('Chip amount must be a non-negative safe integer');
}
