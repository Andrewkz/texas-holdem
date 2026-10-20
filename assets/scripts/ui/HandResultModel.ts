export interface HandAward {
  playerId: string;
  amount: number;
  handName: string;
}
export interface HandWinner {
  playerId: string;
  name: string;
  amount: number;
  handNames: string[];
  isSelf: boolean;
}
export interface HandResult {
  handId: number;
  winners: HandWinner[];
  totalAwarded: number;
  selfPayout: number;
  /** Only supplied when opening and settled stacks are both known. */
  selfNet?: number;
  awardCount: number;
}

/** Aggregates authoritative awards. An award includes returned stakes and is not net profit. */
export function buildHandResult(
  handId: number,
  awards: readonly HandAward[],
  players: readonly { id: string; name: string }[],
  selfId: string,
  selfNet?: number,
): HandResult {
  const names = new Map(players.map(player => [player.id, player.name]));
  const winners = new Map<string, HandWinner>();
  let totalAwarded = 0, awardCount = 0;
  for (const award of awards) {
    if (!award.playerId || !Number.isSafeInteger(award.amount) || award.amount <= 0) continue;
    let winner = winners.get(award.playerId);
    if (!winner) {
      winner = { playerId: award.playerId, name: names.get(award.playerId) || award.playerId, amount: 0, handNames: [], isSelf: award.playerId === selfId };
      winners.set(award.playerId, winner);
    }
    winner.amount += award.amount;
    if (award.handName && winner.handNames.indexOf(award.handName) === -1) winner.handNames.push(award.handName);
    totalAwarded += award.amount;
    awardCount += 1;
  }
  return {
    handId, winners: Array.from(winners.values()), totalAwarded,
    selfPayout: winners.get(selfId)?.amount ?? 0,
    ...(Number.isSafeInteger(selfNet) ? { selfNet } : {}),
    awardCount,
  };
}
