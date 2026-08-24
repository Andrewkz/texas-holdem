export interface Contribution {
  playerId: string;
  amount: number;
  folded: boolean;
}

export interface Pot {
  amount: number;
  eligiblePlayerIds: string[];
}

export function buildPots(contributions: Contribution[]): Pot[] {
  const levels = [...new Set(contributions
    .map(({ amount }) => amount)
    .filter((amount) => amount > 0))]
    .sort((left, right) => left - right);
  let previous = 0;

  return levels.map((level) => {
    const contributors = contributions.filter(({ amount }) => amount >= level);
    const pot = {
      amount: (level - previous) * contributors.length,
      eligiblePlayerIds: contributors
        .filter(({ folded }) => !folded)
        .map(({ playerId }) => playerId),
    };

    previous = level;
    return pot;
  });
}
