import { describe, expect, it } from 'vitest';
import { SoloTurnClock } from '../../assets/scripts/ui/SoloTurnClock';
import type { PlayerAction } from '../../assets/scripts/core/types';

const facingBet: readonly PlayerAction[] = [{ type: 'fold' }, { type: 'call', amount: 40 }, { type: 'raise', to: 80 }];
const freeCheck: readonly PlayerAction[] = [{ type: 'fold' }, { type: 'check' }, { type: 'raise', to: 40 }];

describe('SoloTurnClock', () => {
  it('starts a thirty-second absolute deadline with the player countdown shape', () => {
    const clock = new SoloTurnClock(() => 100000);
    expect(clock.read()).toBeNull();
    clock.sync('hand-1/action-3', 1, facingBet);
    expect(clock.read()).toEqual({ playerId: 'player', handId: 1, deadlineAt: 130000, seconds: 30, fraction: 1, urgent: false });
    expect(clock.takeExpiredAction()).toBeNull();
  });

  it('rounds upward and becomes urgent at exactly five seconds remaining', () => {
    let now = 0;
    const clock = new SoloTurnClock(() => now);
    clock.sync('turn', 2, freeCheck);
    now = 24999;
    expect(clock.read()).toMatchObject({ seconds: 6, urgent: false });
    now = 25000;
    expect(clock.read()).toMatchObject({ seconds: 5, fraction: 1 / 6, urgent: true });
    now = 29999;
    expect(clock.read()?.seconds).toBe(1);
    expect(clock.takeExpiredAction()).toBeNull();
    now = 30000;
    expect(clock.read()).toMatchObject({ seconds: 0, fraction: 0, urgent: true });
    expect(clock.takeExpiredAction()).toEqual({ type: 'check' });
  });

  it('does not restart the same turn on repeated rendering or legal-action updates', () => {
    let now = 0;
    const clock = new SoloTurnClock(() => now);
    clock.sync('turn', 2, facingBet);
    now = 18000;
    clock.sync('turn', 2, freeCheck);
    expect(clock.read()).toMatchObject({ deadlineAt: 30000, seconds: 12 });
    now = 30000;
    expect(clock.takeExpiredAction()).toEqual({ type: 'check' });
  });

  it('folds when facing a wager and never auto-calls, raises or shoves', () => {
    let now = 0;
    const clock = new SoloTurnClock(() => now);
    clock.sync('turn', 3, [...facingBet, { type: 'all-in' }]);
    now = 30000;
    expect(clock.takeExpiredAction()).toEqual({ type: 'fold' });
  });

  it('consumes an expired action once and retains a zero countdown until the next turn', () => {
    let now = 0;
    const clock = new SoloTurnClock(() => now);
    clock.sync('turn', 1, freeCheck);
    now = 30000;
    expect(clock.takeExpiredAction()).toEqual({ type: 'check' });
    clock.sync('turn', 1, facingBet);
    expect(clock.takeExpiredAction()).toBeNull();
    now = 90000;
    expect(clock.takeExpiredAction()).toBeNull();
    expect(clock.read()).toMatchObject({ deadlineAt: 30000, seconds: 0, fraction: 0 });
    now = 1000;
    expect(clock.read()).toMatchObject({ seconds: 0, fraction: 0 });
  });

  it('starts a fresh deadline for another action on the same street or a new hand', () => {
    let now = 0;
    const clock = new SoloTurnClock(() => now);
    clock.sync('action-1', 1, facingBet);
    now = 21000;
    clock.sync('action-8', 1, facingBet);
    expect(clock.read()).toMatchObject({ handId: 1, deadlineAt: 51000, seconds: 30 });
    now = 22000;
    clock.sync('action-8', 2, freeCheck);
    expect(clock.read()).toMatchObject({ handId: 2, deadlineAt: 52000, seconds: 30 });
    now = 52000;
    expect(clock.takeExpiredAction()).toEqual({ type: 'check' });
  });

  it('cancels pending actions when leaving the table or handing control to an AI', () => {
    let now = 0;
    const clock = new SoloTurnClock(() => now);
    clock.sync('turn', 1, facingBet);
    clock.sync(null, 1, []);
    now = 60000;
    expect(clock.read()).toBeNull();
    expect(clock.takeExpiredAction()).toBeNull();
    clock.sync('turn', 1, freeCheck);
    expect(clock.read()?.seconds).toBe(30);
    clock.clear();
    expect(clock.read()).toBeNull();
    expect(clock.takeExpiredAction()).toBeNull();
  });

  it('expires immediately after a background wall-clock jump without relying on frame ticks', () => {
    let now = 100000;
    const clock = new SoloTurnClock(() => now);
    clock.sync('turn', 1, facingBet);
    now = 100000 + 5 * 60000;
    expect(clock.takeExpiredAction()).toEqual({ type: 'fold' });
    expect(clock.read()).toMatchObject({ seconds: 0, fraction: 0 });
  });

  it('does not submit an unsupported action when neither check nor fold is legal', () => {
    let now = 0;
    const clock = new SoloTurnClock(() => now);
    clock.sync('turn', 1, [{ type: 'call', amount: 1 }, { type: 'all-in' }]);
    now = 30000;
    expect(clock.takeExpiredAction()).toBeNull();
  });

  it('supports a configured duration while keeping an absolute unchanged deadline', () => {
    let now = 1000;
    const clock = new SoloTurnClock(() => now, 10000);
    clock.sync('turn', 1, freeCheck);
    now = 6000;
    expect(clock.read()).toMatchObject({ deadlineAt: 11000, seconds: 5, fraction: 0.5, urgent: true });
    now = 11000;
    expect(clock.takeExpiredAction()).toEqual({ type: 'check' });
  });
});
