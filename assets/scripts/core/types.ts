export const SUITS = ['S', 'H', 'D', 'C'] as const;
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;

export type Suit = (typeof SUITS)[number];
export type Rank = (typeof RANKS)[number];

export interface Card {
  suit: Suit;
  rank: Rank;
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'settled';

export type PlayerAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call'; amount: number }
  | { type: 'raise'; to: number }
  | { type: 'all-in' };

export interface PlayerSnapshot {
  id: string;
  name: string;
  stack: number;
  folded: boolean;
  allIn: boolean;
  streetContribution: number;
  totalContribution: number;
}

export interface EngineSnapshot {
  handId: number;
  street: Street;
  actingPlayerId: string | null;
  pot: number;
  communityCards: Card[];
  legalActions: PlayerAction[];
  players: readonly PlayerSnapshot[];
}

export type EngineEvent =
  | { handId: number; type: 'blind-posted'; playerId: string; amount: number }
  | { handId: number; type: 'hole-card-dealt'; playerId: string; card?: Card; faceDown: boolean }
  | { handId: number; type: 'action-taken'; playerId: string; action: PlayerAction; amount: number }
  | { handId: number; type: 'community-card-revealed'; card: Card }
  | { handId: number; type: 'showdown'; playerId: string; cards: Card[]; handName: string }
  | { handId: number; type: 'pot-awarded'; playerId: string; amount: number; handName: string };
