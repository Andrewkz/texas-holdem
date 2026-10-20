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

  it('enters the online setup from home and returns', () => {
    const home = createHomeFlow();
    const setup = reduceHomeFlow(home, { type: 'open-online' });

    expect(setup.screen).toBe('online-setup');
    expect(reduceHomeFlow(setup, { type: 'close-online' })).toEqual(home);
  });

  it('moves from setup to lobby and from lobby into the game', () => {
    const setup = reduceHomeFlow(createHomeFlow(), { type: 'open-online' });
    const lobby = reduceHomeFlow(setup, { type: 'entered-lobby' });

    expect(lobby.screen).toBe('online-lobby');
    expect(reduceHomeFlow(lobby, { type: 'leave-lobby' })).toEqual(createHomeFlow());
    expect(reduceHomeFlow(lobby, { type: 'online-game-start' }))
      .toEqual({ screen: 'playing', sessionActive: true });
  });
});

describe('online restore flow', () => {
  it('restores through lobby and ignores success after cancellation', () => {
    const restoring = reduceHomeFlow(createHomeFlow(), { type: 'begin-online-restore' });
    expect(restoring.screen).toBe('online-restoring');
    expect(reduceHomeFlow(restoring, { type: 'entered-lobby' }).screen).toBe('online-lobby');
    const cancelled = reduceHomeFlow(restoring, { type: 'close-online' });
    expect(cancelled.screen).toBe('home');
    expect(reduceHomeFlow(cancelled, { type: 'entered-lobby' })).toBe(cancelled);
  });
  it('returns failed restore to setup and invalidates stale confirmation on lobby return', () => {
    const restoring = reduceHomeFlow(createHomeFlow(), { type: 'begin-online-restore' });
    expect(reduceHomeFlow(restoring, { type: 'restore-failed' }).screen).toBe('online-setup');
    const confirming = { screen: 'return-confirmation', sessionActive: true } as const;
    expect(reduceHomeFlow(confirming, { type: 'online-back-to-lobby' }))
      .toEqual({ screen: 'online-lobby', sessionActive: false });
  });
});

it('keeps an explicitly left online identity separate from the home auto-resume flow', () => {
  let flow = reduceHomeFlow(createHomeFlow(), { type: 'open-online' });
  flow = reduceHomeFlow(flow, { type: 'entered-lobby' });
  flow = reduceHomeFlow(flow, { type: 'left-online-seat' });
  expect(flow).toEqual({ screen: 'online-left', sessionActive: false });
  expect(reduceHomeFlow(flow, { type: 'online-game-start' })).toBe(flow);
  expect(reduceHomeFlow(flow, { type: 'request-rejoin' })).toEqual({ screen: 'online-restoring', sessionActive: false });
});

it('ends an online game with a final result and ignores late lobby or game pushes', () => {
  const playing = { screen: 'playing' as const, sessionActive: true };
  const ended = reduceHomeFlow(playing, { type: 'session-ended' });
  expect(ended).toEqual({ screen: 'online-settlement', sessionActive: false });
  expect(reduceHomeFlow(ended, { type: 'entered-lobby' })).toBe(ended);
  expect(reduceHomeFlow(ended, { type: 'online-game-start' })).toBe(ended);
  expect(reduceHomeFlow(ended, { type: 'close-session-result' })).toEqual(createHomeFlow());
});

it('replaces a pending leave or return confirmation with the fixed final settlement', () => {
  for (const screen of ['online-left', 'online-restoring', 'online-lobby', 'return-confirmation'] as const) {
    expect(reduceHomeFlow({ screen, sessionActive: screen === 'return-confirmation' }, { type: 'session-ended' }))
      .toEqual({ screen: 'online-settlement', sessionActive: false });
  }
});
