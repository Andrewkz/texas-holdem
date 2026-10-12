import { RoomManager } from './RoomManager';
import { createWsServer } from './server';

const port = Number(process.env.PORT ?? 2567);

createWsServer(new RoomManager(), port);
console.log(`texas-holdem server listening on :${port}`);
