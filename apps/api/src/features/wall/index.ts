// Public API of the wall feature (BUILD-ORDER "Module signatures fixed in Phase 1b"). The composition root imports only
// from here. Phase 1b stub: the signature is final, the Phase 2 wall unit fills the body and keeps every exported name
// and type.
import { Router, type RequestHandler } from 'express';

import type { Database } from '../../db/client.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { FriendshipReader } from '../../shared/ports/friendship-reader.js';
import type { SocketEventLimiter } from '../../shared/realtime/event-limiter.js';
import type { SessionGuard } from '../../shared/realtime/session-guard.js';
import type { RealtimePublisher, SocketRegistrar } from '../../shared/realtime/types.js';

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
}

export interface WallModule {
  /** Mounted at `/api`; declares `/users/:id/posts` and `/posts/:id`. */
  router: Router;
  /** `wall:join` / `wall:leave`. */
  registerSocket: SocketRegistrar;
}

export function createWallModule(_deps: WallModuleDeps): WallModule {
  return { router: Router(), registerSocket: () => undefined };
}
