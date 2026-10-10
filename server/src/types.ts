import { ServerMessage } from '../../assets/scripts/net/protocol';

export interface ClientConnection {
  send(message: ServerMessage): void;
}
