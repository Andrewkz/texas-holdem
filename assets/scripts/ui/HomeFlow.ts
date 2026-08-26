export type HomeScreen = 'home' | 'rules' | 'settings' | 'starting' | 'playing' | 'return-confirmation';

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
  | { type: 'confirm-return' };

export function createHomeFlow(): HomeFlowState {
  return { screen: 'home', sessionActive: false };
}

export function reduceHomeFlow(state: HomeFlowState, event: HomeFlowEvent): HomeFlowState {
  if (state.screen === 'home') {
    if (event.type === 'open-rules') {
      return { screen: 'rules', sessionActive: false };
    }
    if (event.type === 'open-settings') {
      return { screen: 'settings', sessionActive: false };
    }
    if (event.type === 'request-start') {
      return { screen: 'starting', sessionActive: false };
    }
  }

  if ((state.screen === 'rules' || state.screen === 'settings') && event.type === 'close-modal') {
    return createHomeFlow();
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
