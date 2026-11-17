import type { Logger } from 'pino';

import { ok, onClientEvent } from '../../shared/realtime/ack.js';
import type { SocketEventLimiter } from '../../shared/realtime/event-limiter.js';
import { rooms } from '../../shared/realtime/rooms.js';
import type { SessionGuard } from '../../shared/realtime/session-guard.js';
import type { SocketRegistrar } from '../../shared/realtime/types.js';
import { WallRoomPayload } from './wall.schema.js';
import type { WallService } from './wall.service.js';

export interface WallSocketDeps {
  service: Pick<WallService, 'assertCanView'>;
  /** `wall:join` per user (`limits.wallJoin`, 30/min in production). */
  joinLimiter: SocketEventLimiter;
  /** `wall:join` re-checks the session before anything else (ADR-0005). */
  sessionGuard: SessionGuard;
  logger: Pick<Logger, 'debug' | 'error'>;
}

/** One socket's membership of one room, as `joinWhilePermitted` uses it. */
export interface RoomMembership {
  join(): Promise<void> | void;
  leave(): Promise<void> | void;
}

/**
 * Joins only while `assertPermitted` holds, also against a concurrent unfriend (B-39). An unfriend deletes the row
 * and then removes the former friend's sockets from the wall room, but it can only remove sockets that are already
 * in it: a join whose check ran before that delete and whose `join` ran after that removal would stay in the room and
 * keep receiving the wall's events. So the permission is checked again once the socket is in the room. Either the
 * second check sees the ended friendship and the socket leaves again, or the delete commits after the second check
 * started, and then the unfriend's room removal runs after the join and finds the socket.
 */
export async function joinWhilePermitted(
  assertPermitted: () => Promise<void>,
  membership: RoomMembership,
): Promise<void> {
  await assertPermitted();
  await membership.join();
  try {
    await assertPermitted();
  } catch (error) {
    await membership.leave();
    throw error;
  }
}

/**
 * `wall:join` / `wall:leave` (API.md §3). Joining `rooms.wall(ownerId)` is the only way a socket receives a wall's
 * `wall:post-created` / `wall:post-deleted`, and it is permission-checked with the same rule as the HTTP history
 * (B-23, B-39, B-40). Both events go through `onClientEvent`: Zod-validated payloads (F-112), errors as acks, never a
 * throw to socket.io.
 */
export function createWallSocketRegistrar({
  service,
  joinLimiter,
  sessionGuard,
  logger,
}: WallSocketDeps): SocketRegistrar {
  return (socket) => {
    onClientEvent(socket, 'wall:join', {
      schema: WallRoomPayload,
      sessionGuard,
      limiter: joinLimiter,
      logger,
      async handle({ userId }, client) {
        // `not-found` for an unknown user, `forbidden` unless self or friends (mapped by `toSocketFailure`).
        const room = rooms.wall(userId);
        await joinWhilePermitted(() => service.assertCanView({ userId: client.data.user.id }, userId), {
          join: () => client.join(room),
          leave: () => client.leave(room),
        });
        return ok();
      },
    });

    // Not mutating and always allowed: leaving a room the socket is not in is a no-op.
    onClientEvent(socket, 'wall:leave', {
      schema: WallRoomPayload,
      logger,
      async handle({ userId }, client) {
        await client.leave(rooms.wall(userId));
        return ok();
      },
    });
  };
}
