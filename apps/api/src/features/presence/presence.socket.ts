import type { Logger } from 'pino';

import { rooms } from '../../shared/realtime/rooms.js';
import type { AppServer, SocketRegistrar } from '../../shared/realtime/types.js';
import type { PresenceEvents, PresenceService } from './presence.service.js';

/**
 * Presence deltas to every connected socket except the user's own ones (API.md §3): another tab of the user never
 * hears that its own user joined or left. Every socket on the server passed the authenticated handshake (B-38), and
 * the payload is the handshake's `UserSummary` (public fields only, F-90, B-19) or just the id.
 */
export function presenceEvents(io: AppServer): PresenceEvents {
  return {
    joined(user) {
      io.except(rooms.user(user.id)).emit('presence:joined', user);
    },
    left(userId) {
      io.except(rooms.user(userId)).emit('presence:left', { userId });
    },
  };
}

/** A socket in the shared presence sets: `<instanceId>:<socketId>` (ADR-0009). */
export function socketRefOf(instanceId: string, socketId: string): string {
  return `${instanceId}:${socketId}`;
}

export interface PresenceSocketDeps {
  service: PresenceService;
  instanceId: string;
  logger: Pick<Logger, 'error'>;
}

/**
 * Registered first (ADR-0008), so presence counts every accepted socket, including one that a later registrar
 * closes again. Listens to no client event: connecting and disconnecting are the only inputs. Store failures are
 * logged, never thrown (a registrar must not throw, and an unhandled rejection would stop the process).
 *
 * The user comes from the handshake (`socket.data.user`), so connect and disconnect never touch Postgres (B-75).
 */
export function createPresenceSocket({ service, instanceId, logger }: PresenceSocketDeps): SocketRegistrar {
  return (socket, io) => {
    const { user } = socket.data;
    const socketRef = socketRefOf(instanceId, socket.id);
    const events = presenceEvents(io);

    service.connected(user, socketRef, events).catch((error: unknown) => {
      logger.error({ err: error, userId: user.id, socketId: socket.id }, 'presence connect failed');
    });
    // Commands of one Redis client run in the order they were sent, so this removal can never overtake the add above.
    socket.on('disconnect', () => {
      service.disconnected(user.id, socketRef, events).catch((error: unknown) => {
        logger.error({ err: error, userId: user.id, socketId: socket.id }, 'presence disconnect failed');
      });
    });
  };
}
