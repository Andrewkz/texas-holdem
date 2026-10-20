import { describe, expect, it } from 'vitest';
import { TurnCountdown } from '../../assets/scripts/ui/TurnCountdown';

const timer = { playerId: 'p1', deadlineAt: 130000, serverNow: 100000, durationMs: 30000 };

describe('TurnCountdown', () => {
  it('anchors server remaining time to the monotonic receive clock and rounds seconds upward', () => {
    let now = 500;
    const countdown = new TurnCountdown(() => now);
    countdown.sync(timer, 3);
    expect(countdown.read()).toEqual({ playerId: 'p1', handId: 3, deadlineAt: 130000, seconds: 30, fraction: 1, urgent: false });
    now += 25001;
    expect(countdown.read()).toEqual({ playerId: 'p1', handId: 3, deadlineAt: 130000, seconds: 5, fraction: 4999 / 30000, urgent: true });
    now += 10000;
    expect(countdown.read()).toEqual({ playerId: 'p1', handId: 3, deadlineAt: 130000, seconds: 0, fraction: 0, urgent: true });
  });

  it('never extends the same turn after repeated sync but accepts a different actor or deadline', () => {
    let now = 0;
    const countdown = new TurnCountdown(() => now);
    countdown.sync(timer, 1);
    now = 10000;
    countdown.sync(timer, 1);
    expect(countdown.read()?.seconds).toBe(20);
    countdown.sync({ ...timer, serverNow: 125000 }, 1);
    expect(countdown.read()?.seconds).toBe(5);
    countdown.sync({ ...timer, playerId: 'p2' }, 1);
    expect(countdown.read()).toMatchObject({ playerId: 'p2', seconds: 30 });
    countdown.sync({ ...timer, playerId: 'p2', deadlineAt: 150000, serverNow: 120000 }, 1);
    expect(countdown.read()?.seconds).toBe(30);
    countdown.sync(timer, 2);
    expect(countdown.read()).toMatchObject({ handId: 2, seconds: 30 });
  });

  it('clamps remaining time and hides missing, invalid or explicitly cleared data', () => {
    const countdown = new TurnCountdown(() => 0);
    countdown.sync({ ...timer, serverNow: 0 }, 1);
    expect(countdown.read()?.fraction).toBe(1);
    countdown.sync({ ...timer, deadlineAt: 1 }, 2);
    expect(countdown.read()?.seconds).toBe(0);
    countdown.sync(null, 2);
    expect(countdown.read()).toBeNull();
    countdown.sync(timer, 2);
    countdown.clear();
    expect(countdown.read()).toBeNull();
    countdown.sync({ ...timer, durationMs: 0 }, 2);
    expect(countdown.read()).toBeNull();
    countdown.sync({ ...timer, deadlineAt: NaN }, 2);
    expect(countdown.read()).toBeNull();
  });
});
