import { PlayerAction, Street } from '../core/types';

export type AiStyle = 'tight' | 'calling' | 'aggressive' | 'balanced' | 'unpredictable';

export interface AiProfile {
  readonly style: AiStyle;
  readonly aggression: number;
  readonly looseness: number;
  readonly bluffFrequency: number;
  readonly sizingVariance: number;
  readonly tempo: number;
}

export const DEFAULT_AI_PROFILE: AiProfile = Object.freeze({
  style: 'balanced',
  aggression: 0.5,
  looseness: 0.5,
  bluffFrequency: 0.16,
  sizingVariance: 0.42,
  tempo: 1,
});

const STYLE_PROFILES: readonly AiProfile[] = [
  { style: 'tight', aggression: 0.32, looseness: 0.22, bluffFrequency: 0.08, sizingVariance: 0.18, tempo: 1 },
  { style: 'calling', aggression: 0.24, looseness: 0.78, bluffFrequency: 0.08, sizingVariance: 0.25, tempo: 1 },
  { style: 'aggressive', aggression: 0.8, looseness: 0.62, bluffFrequency: 0.24, sizingVariance: 0.62, tempo: 1 },
  DEFAULT_AI_PROFILE,
  { style: 'unpredictable', aggression: 0.62, looseness: 0.66, bluffFrequency: 0.32, sizingVariance: 0.9, tempo: 1 },
];

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function randomUnit(random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? clamp(value, 0, 1 - Number.EPSILON) : 0.5;
}

/** Create once per table; retain these profiles across hands rather than rerolling each action. */
export function createAiTableProfiles(seatIds: readonly string[], random: () => number): Map<string, AiProfile> {
  const styles = [...STYLE_PROFILES];
  for (let index = styles.length - 1; index > 0; index -= 1) {
    const other = Math.floor(randomUnit(random) * (index + 1));
    [styles[index], styles[other]] = [styles[other], styles[index]];
  }
  const profiles = new Map<string, AiProfile>();
  const variation = (value: number): number => clamp(value + (randomUnit(random) - 0.5) * 0.08, 0, 1);
  for (let index = 0; index < seatIds.length; index += 1) {
    const base = styles[index % styles.length];
    profiles.set(seatIds[index], Object.freeze({
      style: base.style,
      aggression: variation(base.aggression),
      looseness: variation(base.looseness),
      bluffFrequency: variation(base.bluffFrequency),
      sizingVariance: variation(base.sizingVariance),
      tempo: 0.85 + randomUnit(random) * 0.3,
    }));
  }
  return profiles;
}

export interface AiThinkContext {
  readonly street: Street;
  readonly toCall: number;
  readonly pot: number;
  readonly stack: number;
  readonly legalActions: readonly PlayerAction[];
}

/** Timing uses only public decision pressure, never private cards or the selected action. */
export function getAiThinkDelay(context: AiThinkContext, profile: AiProfile, random: () => number): number {
  const triangular = (randomUnit(random) + randomUnit(random)) / 2;
  const toCall = Number.isFinite(context.toCall) ? Math.max(0, context.toCall) : 0;
  const pot = Number.isFinite(context.pot) ? Math.max(0, context.pot) : 0;
  const stack = Number.isFinite(context.stack) ? Math.max(0, context.stack) : 0;
  const pressure = clamp(toCall / Math.max(1, pot + toCall), 0, 1);
  const stackPressure = clamp(toCall / Math.max(1, stack), 0, 1);
  const streetDepth = context.street === 'flop' ? 1 : context.street === 'turn' ? 2 : context.street === 'river' ? 3 : 0;
  const canCheck = context.legalActions.some((action) => action.type === 'check');
  const tempo = Number.isFinite(profile.tempo) ? clamp(profile.tempo, 0.85, 1.15) : 1;
  const seconds = 0.42 + triangular * 0.95 + pressure * 0.25 + stackPressure * 0.12
    + streetDepth * 0.055 + (canCheck ? 0 : 0.08);
  return clamp(seconds * tempo, 0.35, 1.8);
}
