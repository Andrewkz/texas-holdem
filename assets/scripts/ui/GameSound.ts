export const GAME_SOUND_EVENTS = ['ui-click', 'card', 'chip', 'settlement', 'check', 'fold', 'turn', 'turn-warning'] as const;
export type GameSoundEvent = typeof GAME_SOUND_EVENTS[number];
export interface SoundPreferences { soundEnabled: boolean; soundVolume: number; actionAlertsEnabled: boolean; }

export function resolveGameSound(event: GameSoundEvent, soundEnabled: boolean): GameSoundEvent | null {
  return soundEnabled ? event : null;
}

export function resolveSoundPlayback(event: GameSoundEvent, settings: SoundPreferences): { event: GameSoundEvent; volume: number } | null {
  if (!settings.soundEnabled || !Number.isFinite(settings.soundVolume) || settings.soundVolume <= 0) return null;
  if ((event === 'turn' || event === 'turn-warning') && !settings.actionAlertsEnabled) return null;
  const gain = event === 'settlement' ? 0.7 : event === 'turn-warning' ? 0.65 : event === 'turn' ? 0.6 : event === 'check' || event === 'fold' ? 0.4 : 0.55;
  return { event, volume: Math.min(1, settings.soundVolume) * gain };
}

export interface TurnSoundInput {
  /** Includes table epoch, hand, actor and authoritative deadline. */
  turnKey: string | null;
  isOwnTurn: boolean;
  seconds: number;
  /** False consumes this boundary silently, avoiding catch-up after unmute or foreground. */
  canAlert: boolean;
}

/** A display reminder only. Never sends actions or changes server timing. */
export class TurnSoundGate {
  private readonly turns = new Map<string, { warning: boolean }>();

  public read(input: TurnSoundInput): 'turn' | 'turn-warning' | null {
    if (!input.turnKey || !input.isOwnTurn || !Number.isFinite(input.seconds)) return null;
    let state = this.turns.get(input.turnKey);
    if (!state) {
      state = { warning: input.seconds <= 5 };
      this.turns.set(input.turnKey, state);
      if (this.turns.size > 128) this.turns.delete(this.turns.keys().next().value!);
      return input.canAlert && input.seconds > 0 ? (state.warning ? 'turn-warning' : 'turn') : null;
    }
    if (!state.warning && input.seconds <= 5) {
      state.warning = true;
      return input.canAlert && input.seconds > 0 ? 'turn-warning' : null;
    }
    return null;
  }
}
