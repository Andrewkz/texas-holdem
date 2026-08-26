import { describe, expect, it } from 'vitest';

import { GAME_SOUND_EVENTS, resolveGameSound } from '../../assets/scripts/ui/GameSound';

describe('game sound gate', () => {
  it('passes every supported semantic event when sound is enabled', () => {
    expect(GAME_SOUND_EVENTS).toEqual(['ui-click', 'card', 'chip', 'settlement']);
    for (const event of GAME_SOUND_EVENTS) {
      expect(resolveGameSound(event, true)).toBe(event);
    }
  });

  it('suppresses every event when sound is disabled', () => {
    for (const event of GAME_SOUND_EVENTS) {
      expect(resolveGameSound(event, false)).toBeNull();
    }
  });
});
