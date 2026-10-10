import {
  ClientMessage,
  ErrorCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from '../../assets/scripts/net/protocol';
import { Room, RoomOptions } from './Room';
import { ClientConnection } from './types';

export interface RoomManagerOptions extends RoomOptions {
  random?: () => number;
}

interface ConnectionState {
  roomCode: string | null;
  playerId: string | null;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly states = new Map<ClientConnection, ConnectionState>();
  private readonly random: () => number;
  private readonly roomOptions: RoomOptions;

  public constructor(options: RoomManagerOptions = {}) {
    this.random = options.random ?? Math.random;
    this.roomOptions = {
      actionTimeoutMs: options.actionTimeoutMs,
      reconnectWindowMs: options.reconnectWindowMs,
      betweenHandsMs: options.betweenHandsMs,
    };
  }

  public handleOpen(connection: ClientConnection): void {
    this.states.set(connection, { roomCode: null, playerId: null });
  }

  public handleClose(connection: ClientConnection): void {
    const state = this.states.get(connection);
    this.states.delete(connection);

    if (!state?.roomCode || !state.playerId) {
      return;
    }

    this.rooms.get(state.roomCode)?.markDisconnected(state.playerId);
  }

  public handleMessage(connection: ClientConnection, message: ClientMessage): void {
    switch (message.type) {
      case 'createRoom': {
        if (this.states.get(connection)?.roomCode) {
          this.sendError(connection, 'bad-message', '请先离开当前房间');
          return;
        }

        const code = this.generateRoomCode();
        const room = new Room(code, this.roomOptions, () => this.rooms.delete(code));
        this.rooms.set(code, room);
        this.joinRoom(connection, room, message.nickname);
        return;
      }
      case 'joinRoom': {
        if (this.states.get(connection)?.roomCode) {
          this.sendError(connection, 'bad-message', '请先离开当前房间');
          return;
        }

        const room = this.rooms.get(message.roomCode.toUpperCase());

        if (!room) {
          this.sendError(connection, 'room-not-found', '房间不存在');
          return;
        }

        this.joinRoom(connection, room, message.nickname);
        return;
      }
      case 'reconnect': {
        const room = this.rooms.get(message.roomCode.toUpperCase());
        const player = room?.reconnectPlayer(message.token, connection) ?? null;

        if (!room || !player) {
          this.sendError(connection, 'room-not-found', '无法恢复座位');
          return;
        }

        for (const [other, otherState] of this.states) {
          if (other !== connection && otherState.roomCode === room.code && otherState.playerId === player.id) {
            this.states.delete(other);
          }
        }

        this.states.set(connection, { roomCode: room.code, playerId: player.id });
        connection.send({
          type: 'joined',
          roomCode: room.code,
          token: player.token,
          playerId: player.id,
          room: room.roomState(),
        });
        return;
      }
      case 'leaveRoom': {
        const state = this.states.get(connection);
        const room = state?.roomCode ? this.rooms.get(state.roomCode) : undefined;

        if (!state?.roomCode || !state.playerId || !room) {
          this.sendError(connection, 'not-in-room', '你不在任何房间中');
          return;
        }

        room.removePlayer(state.playerId);
        this.states.set(connection, { roomCode: null, playerId: null });
        return;
      }
      case 'startGame': {
        const state = this.states.get(connection);
        const room = state?.roomCode ? this.rooms.get(state.roomCode) : undefined;

        if (!state?.roomCode || !state.playerId || !room) {
          this.sendError(connection, 'not-in-room', '你不在任何房间中');
          return;
        }

        if (state.playerId !== room.hostId) {
          this.sendError(connection, 'not-host', '只有房主可以开始游戏');
          return;
        }

        this.sendError(connection, 'bad-message', '至少需要 2 名玩家');
        return;
      }
      case 'action': {
        this.sendError(connection, 'game-not-started', '牌局尚未开始');
        return;
      }
    }
  }

  public roomCount(): number {
    return this.rooms.size;
  }

  private joinRoom(connection: ClientConnection, room: Room, nickname: string): void {
    const result = room.addPlayer(nickname, connection);

    if (result.ok === false) {
      this.sendError(connection, result.code, result.message);
      return;
    }

    this.states.set(connection, { roomCode: room.code, playerId: result.player.id });
    connection.send({
      type: 'joined',
      roomCode: room.code,
      token: result.player.token,
      playerId: result.player.id,
      room: room.roomState(),
    });
  }

  private generateRoomCode(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = Array.from(
        { length: ROOM_CODE_LENGTH },
        () => ROOM_CODE_ALPHABET[Math.floor(this.random() * ROOM_CODE_ALPHABET.length)],
      ).join('');

      if (!this.rooms.has(code)) {
        return code;
      }
    }

    throw new Error('Unable to allocate room code');
  }

  private sendError(connection: ClientConnection, code: ErrorCode, message: string): void {
    connection.send({ type: 'error', code, message });
  }
}
