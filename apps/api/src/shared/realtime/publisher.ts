import { rooms } from './rooms.js';
import type { AppServer, RealtimePublisher } from './types.js';

export type { RealtimePublisher } from './types.js';

/**
 * The real `RealtimePublisher` around the (possibly not yet attached) socket.io server (ADR-0008). `container.ts`
 * creates it next to the `Server`, so services can be built before `server.ts` attaches io to the HTTP server; every
 * call before that simply reaches no socket.
 *
 * All three operations go through the adapter (`io.to/in(...)`), so they keep working unchanged once a Redis adapter
 * connects several instances.
 */
export function createRealtimePublisher(io: AppServer): RealtimePublisher {
  return {
    emitToRoom(room, event, ...args) {
      io.to(room).emit(event, ...args);
    },
    leaveRoom(socketsInRoom, room) {
      io.in(socketsInRoom).socketsLeave(room);
    },
    disconnectSession(sessionId) {
      // `true` closes the underlying connection too; the client gets `io server disconnect` and never retries it.
      io.in(rooms.session(sessionId)).disconnectSockets(true);
    },
  };
}
