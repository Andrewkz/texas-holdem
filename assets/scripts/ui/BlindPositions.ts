import type { EngineEvent } from '../core/types';

/** Positions belong to the participants at the start of one hand, even after a fold or all-in. */
export interface HandPositions {
  handId: number;
  dealerPlayerId: string;
  smallBlindPlayerId: string;
  bigBlindPlayerId: string;
}

export function deriveBlindPositions(handId: number, orderedParticipantIds: readonly string[], dealerPlayerId: string): HandPositions | null {
  if (!Number.isSafeInteger(handId) || handId < 1 || !validSeats(orderedParticipantIds)) return null;
  const dealer = orderedParticipantIds.indexOf(dealerPlayerId);
  if (dealer < 0) return null;
  const smallBlind = orderedParticipantIds.length === 2 ? dealer : (dealer + 1) % orderedParticipantIds.length;
  return {
    handId,
    dealerPlayerId,
    smallBlindPlayerId: orderedParticipantIds[smallBlind],
    bigBlindPlayerId: orderedParticipantIds[(smallBlind + 1) % orderedParticipantIds.length],
  };
}

/** Read public event identities only; blind amounts cannot identify short-stack positions. */
export function fromSoloBlindEvents(handId: number, orderedSeatIds: readonly string[], events: readonly EngineEvent[], snapshotDealer: string | null): HandPositions | null {
  if (!Number.isSafeInteger(handId) || handId < 1 || !validSeats(orderedSeatIds)) return null;
  const currentEvents = events.filter(event => event.handId === handId);
  const dealtIds = new Set(currentEvents.filter(event => event.type === 'hole-card-dealt').map(event => event.playerId));
  if (Array.from(dealtIds).some(id => orderedSeatIds.indexOf(id) < 0)) return null;
  const participants = orderedSeatIds.filter(id => dealtIds.has(id));
  if (!validSeats(participants)) return null;
  const blinds = currentEvents.filter(event => event.type === 'blind-posted');
  if (blinds.length < 2) return null;
  const smallBlindId = blinds[0].playerId;
  const bigBlindId = blinds[1].playerId;
  const smallBlindIndex = participants.indexOf(smallBlindId);
  if (smallBlindIndex < 0 || smallBlindId === bigBlindId) return null;
  const inferredDealer = participants.length === 2
    ? smallBlindId
    : participants[(smallBlindIndex + participants.length - 1) % participants.length];
  const positions = deriveBlindPositions(handId, participants, snapshotDealer ?? inferredDealer);
  if (positions?.smallBlindPlayerId !== smallBlindId || positions.bigBlindPlayerId !== bigBlindId) return null;
  return positions;
}

function validSeats(ids: readonly string[]): boolean {
  return ids.length >= 2 && ids.length <= 6
    && ids.every(id => typeof id === 'string' && id.trim().length > 0)
    && new Set(ids).size === ids.length;
}
