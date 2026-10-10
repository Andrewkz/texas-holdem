import { randomUUID } from 'node:crypto';

import {
  ACTION_TIMEOUT_MS,
  BETWEEN_HANDS_MS,
  ErrorCode,
  MAX_SEATS,
  RECONNECT_WINDOW_MS,
  RoomStateMessage,
  ServerMessage,
  STARTING_STACK,
} from '../../assets/scripts/net/protocol';
import { ClientConnection } from './types';

export interface RoomPlayer {
  id: string;
  nickname: string;
  token: string;
  stack: number;
  connected: boolean;
  connection: ClientConnection | null;
  autoFold: boolean;
}

export interface RoomOptions {
  actionTimeoutMs?: number;
  reconnectWindowMs?: number;
  betweenHandsMs?: number;
}

export type JoinResult =
  | { ok: true; player: RoomPlayer }
  | { ok: false; code: ErrorCode; message: string };

export class Room {
  public phase: 'lobby' | 'playing' = 'lobby';
  public hostId = '';
  protected readonly players: RoomPlayer[] = [];
  protected readonly options: Required<RoomOptions>;
  private nextPlayerNumber = 1;

  public constructor(
    public readonly code: string,
    options: RoomOptions,
    private readonly onEmpty: () => void,
  ) {
    this.options = {
      actionTimeoutMs: options.actionTimeoutMs ?? ACTION_TIMEOUT_MS,
      reconnectWindowMs: options.reconnectWindowMs ?? RECONNECT_WINDOW_MS,
      betweenHandsMs: options.betweenHandsMs ?? BETWEEN_HANDS_MS,
    };
  }

  public addPlayer(nickname: string, connection: ClientConnection): JoinResult {
    if (this.seatedPlayers().length >= MAX_SEATS) {
      return { ok: false, code: 'room-full', message: '房间已满' };
    }

    if (this.players.some((player) => player.nickname === nickname && !player.autoFold)) {
      return { ok: false, code: 'nickname-taken', message: '昵称已被占用' };
    }

    const player: RoomPlayer = {
      id: `p${this.nextPlayerNumber}`,
      nickname,
      token: randomUUID(),
      stack: STARTING_STACK,
      connected: true,
      connection,
      autoFold: false,
    };
    this.nextPlayerNumber += 1;
    this.players.push(player);

    if (!this.hostId) {
      this.hostId = player.id;
    }

    this.broadcastRoomState();
    return { ok: true, player };
  }

  public reconnectPlayer(token: string, connection: ClientConnection): RoomPlayer | null {
    const player = this.players.find((candidate) => candidate.token === token) ?? null;

    if (!player) {
      return null;
    }

    player.connected = true;
    player.connection = connection;
    this.broadcastRoomState();
    return player;
  }

  public markDisconnected(playerId: string): void {
    const player = this.players.find((candidate) => candidate.id === playerId);

    if (!player) {
      return;
    }

    player.connected = false;
    player.connection = null;
    this.broadcastRoomState();
  }

  public removePlayer(playerId: string): void {
    const index = this.players.findIndex((candidate) => candidate.id === playerId);

    if (index === -1) {
      return;
    }

    this.players.splice(index, 1);

    if (this.hostId === playerId) {
      this.hostId = this.seatedPlayers()[0]?.id ?? '';
    }

    if (this.players.length === 0) {
      this.onEmpty();
      return;
    }

    this.broadcastRoomState();
  }

  public roomState(): RoomStateMessage {
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      seats: this.seatedPlayers().map((player) => ({
        playerId: player.id,
        nickname: player.nickname,
        stack: player.stack,
        connected: player.connected,
      })),
    };
  }

  public broadcastRoomState(): void {
    this.broadcast({ type: 'roomState', room: this.roomState() });
  }

  protected seatedPlayers(): RoomPlayer[] {
    return this.players.filter((player) => !player.autoFold);
  }

  protected broadcast(message: ServerMessage): void {
    for (const player of this.players) {
      player.connection?.send(message);
    }
  }

  protected sendTo(player: RoomPlayer, message: ServerMessage): void {
    player.connection?.send(message);
  }
}
