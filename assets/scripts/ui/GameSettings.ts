import { BlindConfig, DEFAULT_BLINDS, normalizeBlinds } from '../core/Blinds';

export type AnimationSpeed = 0.75 | 1 | 1.25;

export interface GameSettings {
  soundEnabled: boolean;
  soundVolume: number;
  actionAlertsEnabled: boolean;
  animationSpeed: AnimationSpeed;
  confirmReset: boolean;
  /** Optional only for old callers; loaded settings always contain valid blinds. */
  blinds?: BlindConfig;
}

export interface GameSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const GAME_SETTINGS_STORAGE_KEY = 'texas-holdem.game-settings.v1';

export const DEFAULT_GAME_SETTINGS: Readonly<GameSettings> = Object.freeze({
  soundEnabled: true,
  soundVolume: 0.7,
  actionAlertsEnabled: true,
  animationSpeed: 1,
  confirmReset: true,
  blinds: DEFAULT_BLINDS,
});

export function parseGameSettings(raw: string | null): GameSettings {
  if (!raw) {
    return { ...DEFAULT_GAME_SETTINGS, blinds: normalizeBlinds(DEFAULT_BLINDS) };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_GAME_SETTINGS, blinds: normalizeBlinds(DEFAULT_BLINDS) };
  }

  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_GAME_SETTINGS, blinds: normalizeBlinds(DEFAULT_BLINDS) };
  }

  const candidate = value as Partial<GameSettings>;
  return {
    blinds: normalizeBlinds(candidate.blinds),
    soundEnabled: typeof candidate.soundEnabled === 'boolean'
      ? candidate.soundEnabled
      : DEFAULT_GAME_SETTINGS.soundEnabled,
    soundVolume: typeof candidate.soundVolume === 'number' && Number.isFinite(candidate.soundVolume) && candidate.soundVolume >= 0 && candidate.soundVolume <= 1
      ? candidate.soundVolume : DEFAULT_GAME_SETTINGS.soundVolume,
    actionAlertsEnabled: typeof candidate.actionAlertsEnabled === 'boolean'
      ? candidate.actionAlertsEnabled : DEFAULT_GAME_SETTINGS.actionAlertsEnabled,
    animationSpeed: isAnimationSpeed(candidate.animationSpeed)
      ? candidate.animationSpeed
      : DEFAULT_GAME_SETTINGS.animationSpeed,
    confirmReset: typeof candidate.confirmReset === 'boolean'
      ? candidate.confirmReset
      : DEFAULT_GAME_SETTINGS.confirmReset,
  };
}

export function loadGameSettings(storage: GameSettingsStorage): GameSettings {
  try { return parseGameSettings(storage.getItem(GAME_SETTINGS_STORAGE_KEY)); }
  catch { return { ...DEFAULT_GAME_SETTINGS, blinds: normalizeBlinds(DEFAULT_BLINDS) }; }
}

export function saveGameSettings(storage: GameSettingsStorage, settings: GameSettings): void {
  try { storage.setItem(GAME_SETTINGS_STORAGE_KEY, JSON.stringify(settings)); }
  catch { /* Browser storage may be unavailable; the in-memory choice remains usable. */ }
}

export function scaleDuration(baseDuration: number, speed: AnimationSpeed): number {
  return baseDuration / speed;
}

function isAnimationSpeed(value: unknown): value is AnimationSpeed {
  return value === 0.75 || value === 1 || value === 1.25;
}
