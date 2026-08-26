export type AnimationSpeed = 0.75 | 1 | 1.25;

export interface GameSettings {
  soundEnabled: boolean;
  animationSpeed: AnimationSpeed;
  confirmReset: boolean;
}

export interface GameSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const GAME_SETTINGS_STORAGE_KEY = 'texas-holdem.game-settings.v1';

export const DEFAULT_GAME_SETTINGS: Readonly<GameSettings> = Object.freeze({
  soundEnabled: true,
  animationSpeed: 1,
  confirmReset: true,
});

export function parseGameSettings(raw: string | null): GameSettings {
  if (!raw) {
    return { ...DEFAULT_GAME_SETTINGS };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_GAME_SETTINGS };
  }

  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_GAME_SETTINGS };
  }

  const candidate = value as Partial<GameSettings>;
  return {
    soundEnabled: typeof candidate.soundEnabled === 'boolean'
      ? candidate.soundEnabled
      : DEFAULT_GAME_SETTINGS.soundEnabled,
    animationSpeed: isAnimationSpeed(candidate.animationSpeed)
      ? candidate.animationSpeed
      : DEFAULT_GAME_SETTINGS.animationSpeed,
    confirmReset: typeof candidate.confirmReset === 'boolean'
      ? candidate.confirmReset
      : DEFAULT_GAME_SETTINGS.confirmReset,
  };
}

export function loadGameSettings(storage: GameSettingsStorage): GameSettings {
  return parseGameSettings(storage.getItem(GAME_SETTINGS_STORAGE_KEY));
}

export function saveGameSettings(storage: GameSettingsStorage, settings: GameSettings): void {
  storage.setItem(GAME_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function scaleDuration(baseDuration: number, speed: AnimationSpeed): number {
  return baseDuration / speed;
}

function isAnimationSpeed(value: unknown): value is AnimationSpeed {
  return value === 0.75 || value === 1 || value === 1.25;
}
