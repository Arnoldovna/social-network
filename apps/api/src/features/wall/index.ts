// Public API of the wall feature (BUILD-ORDER "Module signatures fixed in Phase 1b"). The composition root imports only
// from here. The exported names and the deps/return types are the frozen Phase 1b signature.
import type { Router, RequestHandler } from 'express';
import type { Logger } from 'pino';

import type { Database } from '../../db/client.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { FriendshipReader } from '../../shared/ports/friendship-reader.js';
import type { SocketEventLimiter } from '../../shared/realtime/event-limiter.js';
import type { SessionGuard } from '../../shared/realtime/session-guard.js';
import type { RealtimePublisher, SocketRegistrar } from '../../shared/realtime/types.js';
import { createWallController } from './wall.controller.js';
import { createWallRepository } from './wall.repository.js';
import { createWallRouter } from './wall.routes.js';
import { createWallService } from './wall.service.js';
import { createWallSocketRegistrar } from './wall.socket.js';

export interface WallModuleDeps {
  db: Database;
  requireAuth: RequestHandler;
  /** Friendship and wall writes per user (`limits.write`), one budget shared with the friends module. */
  writeLimiter: RequestHandler;
  /** Owner-or-friend rules for reading and posting (F-65, F-66, B-22, B-23). */
  friendships: FriendshipReader;
  /** `wall:post-created` / `wall:post-deleted` to `rooms.wall(ownerId)`. */
  publisher: RealtimePublisher;
  avatarUrl: AvatarUrl;
  /** `wall:join` per user (`limits.wallJoin`). */
  joinLimiter: SocketEventLimiter;
  /** Per-event session check of `wall:join`. */
  sessionGuard: SessionGuard;
  /** Socket event logging (unexpected errors, rejected joins). */
  logger: Logger;
}

export interface WallModule {
  /** Mounted at `/api`; declares `/users/:id/posts` and `/posts/:id`. */
  router: Router;
  /** `wall:join` / `wall:leave`. */
  registerSocket: SocketRegistrar;
}

export function createWallModule(deps: WallModuleDeps): WallModule {
  const service = createWallService({
    repository: createWallRepository(deps.db),
    friendships: deps.friendships,
    publisher: deps.publisher,
    avatarUrl: deps.avatarUrl,
  });
  return {
    router: createWallRouter({
      controller: createWallController(service),
      requireAuth: deps.requireAuth,
      writeLimiter: deps.writeLimiter,
    }),
    registerSocket: createWallSocketRegistrar({
      service,
      joinLimiter: deps.joinLimiter,
      sessionGuard: deps.sessionGuard,
      logger: deps.logger,
    }),
  };
}
