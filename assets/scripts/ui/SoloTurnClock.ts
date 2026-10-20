import type { PlayerAction } from '../core/types';
import type { TurnCountdownState } from './TurnCountdown';

/** Local solo turns use wall time so returning from a suspended tab cannot extend a wager decision. */
export class SoloTurnClock {
  private turn: {
    key: string;
    handId: number;
    deadlineAt: number;
    canCheck: boolean;
    canFold: boolean;
    consumed: boolean;
  } | null = null;

  public constructor(private readonly now: () => number = () => Date.now(), private readonly durationMs = 30000) {}

  public sync(turnKey: string | null, handId: number, legalActions: readonly PlayerAction[]): void {
    if (turnKey === null) {
      this.clear();
      return;
    }
    if (!this.turn || this.turn.key !== turnKey || this.turn.handId !== handId) {
      this.turn = {
        key: turnKey, handId, deadlineAt: this.now() + this.durationMs,
        canCheck: false, canFold: false, consumed: false,
      };
    }
    // Rendering the same action or changing its legal choices must not buy extra time.
    this.turn.canCheck = legalActions.some(action => action.type === 'check');
    this.turn.canFold = legalActions.some(action => action.type === 'fold');
  }

  public clear(): void { this.turn = null; }

  public read(): TurnCountdownState | null {
    if (!this.turn) return null;
    const remaining = this.turn.consumed ? 0 : Math.max(0, Math.min(this.durationMs, this.turn.deadlineAt - this.now()));
    return {
      playerId: 'player', handId: this.turn.handId, deadlineAt: this.turn.deadlineAt,
      seconds: Math.ceil(remaining / 1000), fraction: remaining / this.durationMs, urgent: remaining <= 5000,
    };
  }

  public takeExpiredAction(): PlayerAction | null {
    if (!this.turn || this.turn.consumed || this.now() < this.turn.deadlineAt) return null;
    const action: PlayerAction | null = this.turn.canCheck ? { type: 'check' }
      : this.turn.canFold ? { type: 'fold' } : null;
    if (action) this.turn.consumed = true;
    return action;
  }
}
