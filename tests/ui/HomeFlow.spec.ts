import { describe, expect, it } from 'vitest';

import { createHomeFlow, reduceHomeFlow } from '../../assets/scripts/ui/HomeFlow';

describe('home flow', () => {
  it('starts on the home screen without a game session', () => {
    expect(createHomeFlow()).toEqual({ screen: 'home', sessionActive: false });
  });

  it('opens and closes the rules and settings modals from home', () => {
    const home = createHomeFlow();

    const rules = reduceHomeFlow(home, { type: 'open-rules' });
    expect(rules.screen).toBe('rules');
    expect(reduceHomeFlow(rules, { type: 'close-modal' })).toEqual(home);

    const settings = reduceHomeFlow(home, { type: 'open-settings' });
    expect(settings.screen).toBe('settings');
    expect(reduceHomeFlow(settings, { type: 'close-modal' })).toEqual(home);
  });

  it('guards the start transition against repeated input', () => {
    const starting = reduceHomeFlow(createHomeFlow(), { type: 'request-start' });
    const repeated = reduceHomeFlow(starting, { type: 'request-start' });

    expect(starting).toEqual({ screen: 'starting', sessionActive: false });
    expect(repeated).toBe(starting);
    expect(reduceHomeFlow(starting, { type: 'complete-start' })).toEqual({ screen: 'playing', sessionActive: true });
  });

  it('keeps the session active when return confirmation is cancelled', () => {
    const playing = { screen: 'playing', sessionActive: true } as const;
    const confirming = reduceHomeFlow(playing, { type: 'request-return', confirmReset: true });

    expect(confirming.screen).toBe('return-confirmation');
    expect(reduceHomeFlow(confirming, { type: 'cancel-return' })).toEqual(playing);
  });

  it('ends the session after confirmation or when confirmation is disabled', () => {
    const playing = { screen: 'playing', sessionActive: true } as const;
    const confirming = reduceHomeFlow(playing, { type: 'request-return', confirmReset: true });

    expect(reduceHomeFlow(confirming, { type: 'confirm-return' })).toEqual(createHomeFlow());
    expect(reduceHomeFlow(playing, { type: 'request-return', confirmReset: false })).toEqual(createHomeFlow());
  });
});
