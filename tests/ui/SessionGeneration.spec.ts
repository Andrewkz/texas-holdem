import { describe, expect, it } from 'vitest';

import { SessionGeneration } from '../../assets/scripts/ui/SessionGeneration';

describe('SessionGeneration', () => {
  it('accepts work only for the current session token', () => {
    const sessions = new SessionGeneration();
    const token = sessions.begin();

    expect(sessions.isCurrent(token)).toBe(true);
    expect(sessions.isCurrent(token + 1)).toBe(false);
  });

  it('invalidates pending work when the session ends', () => {
    const sessions = new SessionGeneration();
    const ended = sessions.begin();

    sessions.invalidate();

    expect(sessions.isCurrent(ended)).toBe(false);
  });

  it('gives a later session a different valid token', () => {
    const sessions = new SessionGeneration();
    const first = sessions.begin();
    sessions.invalidate();
    const second = sessions.begin();

    expect(second).not.toBe(first);
    expect(sessions.isCurrent(first)).toBe(false);
    expect(sessions.isCurrent(second)).toBe(true);
  });
});
