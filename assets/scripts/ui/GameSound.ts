export const GAME_SOUND_EVENTS = ['ui-click', 'card', 'chip', 'settlement'] as const;

export type GameSoundEvent = typeof GAME_SOUND_EVENTS[number];

export function resolveGameSound(event: GameSoundEvent, soundEnabled: boolean): GameSoundEvent | null {
  return soundEnabled ? event : null;
}
