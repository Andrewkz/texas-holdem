/** Chip amounts are whole-number play chips; any increasing ratio is supported. */
export interface BlindConfig {
  smallBlind: number;
  bigBlind: number;
}

export const DEFAULT_BLINDS: Readonly<BlindConfig> = Object.freeze({ smallBlind: 20, bigBlind: 40 });

export function validateBlinds(value: unknown): value is BlindConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<BlindConfig>;
  return Number.isSafeInteger(candidate.smallBlind) && Number.isSafeInteger(candidate.bigBlind)
    && candidate.smallBlind! >= 1 && candidate.smallBlind! < candidate.bigBlind! && candidate.bigBlind! <= 1000;
}

export function assertBlinds(value: unknown): asserts value is BlindConfig {
  if (!validateBlinds(value)) throw new RangeError('Blinds must be whole numbers with 1 <= small blind < big blind <= 1000');
}

/** Untrusted saved preferences fall back to the standard stakes. Always return a copy. */
export function normalizeBlinds(value: unknown): BlindConfig {
  const source = validateBlinds(value) ? value : DEFAULT_BLINDS;
  return { smallBlind: source.smallBlind, bigBlind: source.bigBlind };
}
