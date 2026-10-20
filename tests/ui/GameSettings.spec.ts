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
      soundVolume: 0.7,
      actionAlertsEnabled: true,
      animationSpeed: 1,
      confirmReset: true,
      blinds: {smallBlind:20,bigBlind:40},
    });
  });

  it('falls back field by field when stored values are unsupported', () => {
    expect(parseGameSettings(JSON.stringify({
      soundEnabled: false,
      animationSpeed: 2,
      confirmReset: false,
    }))).toEqual({
      soundEnabled: false,
      soundVolume: 0.7,
      actionAlertsEnabled: true,
      animationSpeed: 1,
      confirmReset: false,
      blinds: {smallBlind:20,bigBlind:40},
    });
  });

  it('falls back to defaults when storage is missing or malformed', () => {
    expect(parseGameSettings(null)).toEqual(DEFAULT_GAME_SETTINGS);
    expect(parseGameSettings('{bad json')).toEqual(DEFAULT_GAME_SETTINGS);
  });

  it('serializes and restores supported settings', () => {
    const storage = new MemoryStorage();
    const expected = { soundEnabled: false, soundVolume: 0.4, actionAlertsEnabled: false, animationSpeed: 1.25 as const, confirmReset: false };

    saveGameSettings(storage, expected);

    expect(storage.getItem(GAME_SETTINGS_STORAGE_KEY)).toBe(JSON.stringify(expected));
    expect(loadGameSettings(storage)).toEqual({...expected,blinds:{smallBlind:20,bigBlind:40}});
  });

  it('converts base durations for all supported speed options', () => {
    expect(scaleDuration(1, 0.75)).toBeCloseTo(4 / 3);
    expect(scaleDuration(1, 1)).toBe(1);
    expect(scaleDuration(1, 1.25)).toBe(0.8);
  });
});

describe('compatible sound preferences', () => {
  it('migrates existing v1 data without changing old preferences', () => {
    expect(parseGameSettings('{"soundEnabled":false,"animationSpeed":1.25,"confirmReset":false}')).toMatchObject({soundEnabled:false,soundVolume:0.7,actionAlertsEnabled:true,animationSpeed:1.25,confirmReset:false});
  });
  it('validates volume and alerts independently', () => {
    for(const value of [-1,1.1,"0.5",null]) expect(parseGameSettings(JSON.stringify({soundVolume:value})).soundVolume).toBe(0.7);
    expect(parseGameSettings('{"soundVolume":0,"actionAlertsEnabled":false}')).toMatchObject({soundVolume:0,actionAlertsEnabled:false});
  });
  it('keeps the game usable when browser storage rejects access', () => {
    const storage={getItem(){throw new Error('blocked')},setItem(){throw new Error('quota')}};
    expect(loadGameSettings(storage)).toEqual(DEFAULT_GAME_SETTINGS);
    expect(()=>saveGameSettings(storage,{...DEFAULT_GAME_SETTINGS})).not.toThrow();
  });
});

describe('saved blind preferences', () => {
  it('migrates old v1 settings and validates corrupt stakes independently', () => {
    expect(parseGameSettings('{"soundEnabled":false}')).toMatchObject({soundEnabled:false,blinds:{smallBlind:20,bigBlind:40}});
    for(const blinds of [null,{smallBlind:0,bigBlind:40},{smallBlind:40,bigBlind:20},{smallBlind:1,bigBlind:1001}])
      expect(parseGameSettings(JSON.stringify({soundEnabled:false,blinds}))).toMatchObject({soundEnabled:false,blinds:{smallBlind:20,bigBlind:40}});
  });
  it('roundtrips custom blinds on the existing storage key', () => {
    const storage=new MemoryStorage();
    const settings={...DEFAULT_GAME_SETTINGS,blinds:{smallBlind:7,bigBlind:15}};
    saveGameSettings(storage,settings);
    expect(loadGameSettings(storage)).toEqual(settings);
    expect(storage.getItem(GAME_SETTINGS_STORAGE_KEY)).toContain('"bigBlind":15');
  });
  it('does not share mutable default blind configuration between loaded settings', () => {
    const first=parseGameSettings(null);first.blinds!.bigBlind=999;
    expect(parseGameSettings(null).blinds).toEqual({smallBlind:20,bigBlind:40});
    expect(DEFAULT_GAME_SETTINGS.blinds).toEqual({smallBlind:20,bigBlind:40});
  });
});
