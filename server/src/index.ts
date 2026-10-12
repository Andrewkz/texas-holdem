import { RoomManager } from './RoomManager';
import { createWsServer } from './server';

const port = Number(process.env.PORT ?? 2567);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}

createWsServer(new RoomManager(), port);
console.log(`texas-holdem server listening on :${port}`);
