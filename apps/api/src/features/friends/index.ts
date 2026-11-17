// Public API of the friends feature (BUILD-ORDER "Module signatures fixed in Phase 1b"). The composition root imports
// only from here. Phase 1b stub: the signature is final and `reader` is already the real one (ADR-0019 §3), so users
// and wall get correct friendship answers however far the Phase 2 friends unit is. That unit fills the router and keeps
// returning `reader: createFriendshipReader(deps.db)`.
import { Router, type RequestHandler } from 'express';

import type { Database } from '../../db/client.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { FriendshipReader } from '../../shared/ports/friendship-reader.js';
import type { RealtimePublisher } from '../../shared/realtime/types.js';
import { createFriendshipReader } from './friendship-reader.js';

export interface FriendsModuleDeps {
  db: Database;
  requireAuth: RequestHandler;
  /** Friendship and wall writes per user (`limits.write`), one budget shared with the wall module. */
  writeLimiter: RequestHandler;
  /** `friendship:changed` to both users; on unfriend both leave each other's wall room (F-52, F-57). */
  publisher: RealtimePublisher;
  avatarUrl: AvatarUrl;
}

export interface FriendsModule {
  /** Mounted at `/api`; declares `/friendships`, `/friendships/:userId/accept`, `/friendships/:userId`. */
  router: Router;
  /** Passed by the composition root to users and wall. */
  reader: FriendshipReader;
}

export function createFriendsModule(deps: FriendsModuleDeps): FriendsModule {
  return { router: Router(), reader: createFriendshipReader(deps.db) };
}
