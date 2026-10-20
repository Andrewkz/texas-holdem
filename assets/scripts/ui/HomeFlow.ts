export type HomeScreen = 'home' | 'rules' | 'settings' | 'online-setup' | 'online-restoring' | 'online-lobby' | 'online-left' | 'online-settlement' | 'starting' | 'playing' | 'return-confirmation';

export interface HomeFlowState {
  screen: HomeScreen;
  sessionActive: boolean;
}

export type HomeFlowEvent =
  | { type: 'open-rules' }
  | { type: 'open-settings' }
  | { type: 'close-modal' }
  | { type: 'request-start' }
  | { type: 'complete-start' }
  | { type: 'request-return'; confirmReset: boolean }
  | { type: 'cancel-return' }
  | { type: 'confirm-return' }
  | { type: 'begin-online-restore' }
  | { type: 'restore-failed' }
  | { type: 'online-back-to-lobby' }
  | { type: 'left-online-seat' }
  | { type: 'session-ended' }
  | { type: 'close-session-result' }
  | { type: 'request-rejoin' }
  | { type: 'open-online' }
  | { type: 'close-online' }
  | { type: 'entered-lobby' }
  | { type: 'leave-lobby' }
  | { type: 'online-game-start' };

export function createHomeFlow(): HomeFlowState {
  return { screen: 'home', sessionActive: false };
}

export function reduceHomeFlow(state: HomeFlowState, event: HomeFlowEvent): HomeFlowState {
  const onlineResult = state.screen === 'online-left' || state.screen === 'online-settlement';
  if (event.type === 'session-ended' && ['online-setup', 'online-restoring', 'online-lobby', 'online-left', 'playing', 'return-confirmation'].indexOf(state.screen) !== -1) {
    return { screen: 'online-settlement', sessionActive: false };
  }
  if (event.type === 'left-online-seat' && ['online-lobby', 'playing', 'return-confirmation'].indexOf(state.screen) !== -1) {
    return { screen: 'online-left', sessionActive: false };
  }
  if (onlineResult && event.type === 'close-session-result') return createHomeFlow();
  if (state.screen === 'online-left' && event.type === 'request-rejoin') return { screen: 'online-restoring', sessionActive: false };
  if (event.type === 'online-back-to-lobby' && (state.screen === 'playing' || state.screen === 'return-confirmation')) {
    return { screen: 'online-lobby', sessionActive: false };
  }
  if (state.screen === 'home') {
    if (event.type === 'begin-online-restore') return { screen: 'online-restoring', sessionActive: false };
    if (event.type === 'open-rules') {
      return { screen: 'rules', sessionActive: false };
    }
    if (event.type === 'open-settings') {
      return { screen: 'settings', sessionActive: false };
    }
    if (event.type === 'request-start') {
      return { screen: 'starting', sessionActive: false };
    }
    if (event.type === 'open-online') {
      return { screen: 'online-setup', sessionActive: false };
    }
  }

  if ((state.screen === 'rules' || state.screen === 'settings') && event.type === 'close-modal') {
    return createHomeFlow();
  }

  if (state.screen === 'online-restoring' && event.type === 'restore-failed') return { screen: 'online-setup', sessionActive: false };
  if (state.screen === 'online-setup' || state.screen === 'online-restoring') {
    if (event.type === 'close-online') {
      return createHomeFlow();
    }
    if (event.type === 'entered-lobby') {
      return { screen: 'online-lobby', sessionActive: false };
    }
  }

  if (state.screen === 'online-lobby') {
    if (event.type === 'leave-lobby') {
      return createHomeFlow();
    }
    if (event.type === 'online-game-start') {
      return { screen: 'playing', sessionActive: true };
    }
  }

  if (state.screen === 'starting') {
    if (event.type === 'request-start') {
      return state;
    }
    if (event.type === 'complete-start') {
      return { screen: 'playing', sessionActive: true };
    }
  }

  if (state.screen === 'playing' && event.type === 'request-return') {
    return event.confirmReset
      ? { screen: 'return-confirmation', sessionActive: true }
      : createHomeFlow();
  }

  if (state.screen === 'return-confirmation') {
    if (event.type === 'cancel-return') {
      return { screen: 'playing', sessionActive: true };
    }
    if (event.type === 'confirm-return') {
      return createHomeFlow();
    }
  }

  return state;
}
