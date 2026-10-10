import { Card, EngineSnapshot, PlayerAction } from '../core/types';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;
export const MAX_SEATS = 6;
export const STARTING_STACK = 5000;
export const ACTION_TIMEOUT_MS = 30_000;
export const RECONNECT_WINDOW_MS = 60_000;
export const BETWEEN_HANDS_MS = 5_000;
export const DEFAULT_SERVER_URL = 'ws://localhost:2567';
export const ONLINE_SESSION_STORAGE_KEY = 'texas-holdem.online.v1';

export interface RoomSeat {
  playerId: string;
  nickname: string;
  stack: number;
  connected: boolean;
}

export interface RoomStateMessage {
  code: string;
  phase: 'lobby' | 'playing';
  hostId: string;
  seats: RoomSeat[];
}

export type ErrorCode =
  | 'bad-message'
  | 'room-not-found'
  | 'room-full'
  | 'nickname-taken'
  | 'not-host'
  | 'not-in-room'
  | 'game-not-started'
  | 'not-your-turn'
  | 'illegal-action';

export type ClientMessage =
  | { type: 'createRoom'; nickname: string }
  | { type: 'joinRoom'; roomCode: string; nickname: string }
  | { type: 'reconnect'; roomCode: string; token: string }
  | { type: 'leaveRoom' }
  | { type: 'startGame' }
  | { type: 'action'; action: PlayerAction };

export type ServerMessage =
  | { type: 'joined'; roomCode: string; token: string; playerId: string; room: RoomStateMessage }
  | { type: 'roomState'; room: RoomStateMessage }
  | { type: 'handStart'; handId: number; dealerPlayerId: string }
  | { type: 'yourHand'; handId: number; cards: Card[] }
  | { type: 'stateSync'; snapshot: EngineSnapshot }
  | { type: 'actionTaken'; playerId: string; action: PlayerAction; amount: number }
  | { type: 'showdown'; handId: number; reveals: { playerId: string; cards: Card[]; handName: string }[] }
  | { type: 'handResult'; handId: number; payouts: { playerId: string; amount: number; handName: string }[] }
  | { type: 'error'; code: ErrorCode; message: string };

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const message = raw as Record<string, unknown>;

  switch (message.type) {
    case 'createRoom': {
      const nickname = parseNickname(message.nickname);
      return nickname ? { type: 'createRoom', nickname } : null;
    }
    case 'joinRoom': {
      const nickname = parseNickname(message.nickname);
      return nickname && typeof message.roomCode === 'string'
        ? { type: 'joinRoom', roomCode: message.roomCode, nickname }
        : null;
    }
    case 'reconnect':
      return typeof message.roomCode === 'string' && typeof message.token === 'string'
        ? { type: 'reconnect', roomCode: message.roomCode, token: message.token }
        : null;
    case 'leaveRoom':
      return { type: 'leaveRoom' };
    case 'startGame':
      return { type: 'startGame' };
    case 'action': {
      const action = parsePlayerAction(message.action);
      return action ? { type: 'action', action } : null;
    }
    default:
      return null;
  }
}

function parseNickname(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const nickname = raw.trim();
  return nickname.length >= 1 && nickname.length <= 12 ? nickname : null;
}

function parsePlayerAction(raw: unknown): PlayerAction | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const action = raw as Record<string, unknown>;

  switch (action.type) {
    case 'fold':
    case 'check':
    case 'all-in':
      return { type: action.type };
    case 'call':
      return typeof action.amount === 'number' ? { type: 'call', amount: action.amount } : null;
    case 'raise':
      return typeof action.to === 'number' ? { type: 'raise', to: action.to } : null;
    default:
      return null;
  }
}
