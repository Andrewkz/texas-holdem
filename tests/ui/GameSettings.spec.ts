import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GAME_SETTINGS,
  GAME_SETTINGS_STORAGE_KEY,
  loadGameSettings,
  parseGameSettings,
  saveGameSettings,
  scaleDuration,
} from '../../assets/scripts/ui/GameSettings';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('game settings', () => {
  it('uses sound on, normal speed, and reset confirmation by default', () => {
    expect(DEFAULT_GAME_SETTINGS).toEqual({
      soundEnabled: true,
      animationSpeed: 1,
      confirmReset: true,
    });
  });

  it('falls back field by field when stored values are unsupported', () => {
    expect(parseGameSettings(JSON.stringify({
      soundEnabled: false,
      animationSpeed: 2,
      confirmReset: false,
    }))).toEqual({
      soundEnabled: false,
      animationSpeed: 1,
      confirmReset: false,
    });
  });

  it('falls back to defaults when storage is missing or malformed', () => {
    expect(parseGameSettings(null)).toEqual(DEFAULT_GAME_SETTINGS);
    expect(parseGameSettings('{bad json')).toEqual(DEFAULT_GAME_SETTINGS);
  });

  it('serializes and restores supported settings', () => {
    const storage = new MemoryStorage();
    const expected = { soundEnabled: false, animationSpeed: 1.25 as const, confirmReset: false };

    saveGameSettings(storage, expected);

    expect(storage.getItem(GAME_SETTINGS_STORAGE_KEY)).toBe(JSON.stringify(expected));
    expect(loadGameSettings(storage)).toEqual(expected);
  });

  it('converts base durations for all supported speed options', () => {
    expect(scaleDuration(1, 0.75)).toBeCloseTo(4 / 3);
    expect(scaleDuration(1, 1)).toBe(1);
    expect(scaleDuration(1, 1.25)).toBe(0.8);
  });
});
