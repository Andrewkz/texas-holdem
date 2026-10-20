import { fileURLToPath } from 'node:url';
import { FileMatchStore } from './session/FileMatchStore';
import { validateMatchRecord } from './session/MatchRecord';
import { RoomManager } from './RoomManager';
import { createWsServer } from './server';
const port = Number(process.env.PORT ?? 2567);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}
const directory = process.env.POKER_DATA_DIR ?? fileURLToPath(new URL('../data', import.meta.url));
const store = new FileMatchStore(directory, validateMatchRecord);
const manager = new RoomManager({ store }); // Recovery must finish before accepting a connection.
createWsServer(manager, port, undefined, process.env.HOST);
console.log(`texas-holdem server listening on :${port}`);
