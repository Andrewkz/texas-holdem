/** Public server timing only; expiry never submits a client-side poker action. */
export interface ServerTurnTimer {
  playerId: string;
  deadlineAt: number;
  serverNow: number;
  durationMs: number;
}

export interface TurnCountdownState {
  playerId: string;
  handId: number;
  deadlineAt: number;
  seconds: number;
  fraction: number;
  urgent: boolean;
}

export class TurnCountdown {
  private turn: { playerId: string; handId: number; deadlineAt: number; durationMs: number; endsAt: number } | null = null;

  public constructor(private readonly now: () => number = () => performance.now()) {}

  public sync(timer: ServerTurnTimer | null | undefined, handId: number): void {
    if (!timer || !timer.playerId || !Number.isFinite(timer.deadlineAt) || !Number.isFinite(timer.serverNow)
      || !Number.isFinite(timer.durationMs) || timer.durationMs <= 0) {
      this.clear();
      return;
    }
    const endsAt = this.now() + Math.max(0, Math.min(timer.durationMs, timer.deadlineAt - timer.serverNow));
    const sameTurn = this.turn && this.turn.playerId === timer.playerId && this.turn.handId === handId
      && this.turn.deadlineAt === timer.deadlineAt;
    this.turn = {
      playerId: timer.playerId, handId, deadlineAt: timer.deadlineAt, durationMs: timer.durationMs,
      // An old or repeated packet must not restart a turn that is already counting down.
      endsAt: sameTurn ? Math.min(this.turn!.endsAt, endsAt) : endsAt,
    };
  }

  public clear(): void { this.turn = null; }

  public read(): TurnCountdownState | null {
    if (!this.turn) return null;
    const remaining = Math.max(0, Math.min(this.turn.durationMs, this.turn.endsAt - this.now()));
    return {
      playerId: this.turn.playerId, handId: this.turn.handId, deadlineAt: this.turn.deadlineAt, seconds: Math.ceil(remaining / 1000),
      fraction: remaining / this.turn.durationMs, urgent: remaining <= 5000,
    };
  }
}
