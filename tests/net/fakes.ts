import { randomBytes } from 'node:crypto';
import { PROTOCOL_VERSION, ServerMessage } from '../../assets/scripts/net/protocol';
import { RoomManager } from '../../server/src/RoomManager';
import { ClientConnection } from '../../server/src/types';

export class FakeConnection implements ClientConnection {
  public readonly sent: ServerMessage[] = [];

  public send(message: ServerMessage): void {
    this.sent.push(message);
  }

  public last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return [...this.sent].reverse().find((message): message is Extract<ServerMessage, { type: T }> => message.type === type);
  }
}

export function connect(manager: RoomManager): FakeConnection {
  const connection = new FakeConnection();
  manager.handleOpen(connection);
  manager.handleMessage(connection, { type: 'hello', protocolVersion: PROTOCOL_VERSION });
  return connection;
}

export function createRoom(manager: RoomManager, nickname = 'Alice') {
  const connection = connect(manager);
  manager.handleMessage(connection, { type: 'createRoom', nickname,requestId:randomBytes(16).toString('hex'),token:randomBytes(32).toString('hex') });
  const joined = connection.last('joined');

  if (!joined) {
    throw new Error('expected joined message');
  }

  return { connection, joined };
}

export function joinRoom(manager: RoomManager, roomCode: string, nickname: string) {
  const connection = connect(manager);
  manager.handleMessage(connection,{type:'lookupRoom',roomCode});
  const lookup=connection.last('roomLookup');
  if(!lookup) throw new Error('expected room lookup');
  manager.handleMessage(connection, { type: 'joinRoom', roomCode, sessionId:lookup.sessionId, nickname,requestId:randomBytes(16).toString('hex'),token:randomBytes(32).toString('hex') });
  const joined = connection.last('joined');

  if (!joined) {
    throw new Error('expected joined message');
  }

  return { connection, joined };
}
