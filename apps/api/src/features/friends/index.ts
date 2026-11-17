// Public API of the friends feature (BUILD-ORDER "Module signatures fixed in Phase 1b"). The composition root imports
// only from here. `reader` is the Phase 1b `createFriendshipReader` (ADR-0019 §3), which users and wall receive.
import type { RequestHandler, Router } from 'express';

import type { Database } from '../../db/client.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { FriendshipReader } from '../../shared/ports/friendship-reader.js';
import type { RealtimePublisher } from '../../shared/realtime/types.js';
import { createFriendshipReader } from './friendship-reader.js';
import { createFriendsController } from './friends.controller.js';
import { createFriendsRepository } from './friends.repository.js';
import { createFriendsRouter } from './friends.routes.js';
import { createFriendsService } from './friends.service.js';

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

/** Construction only, no I/O, never throws: safe to call while the app is being composed (BUILD-ORDER rule 7). */
export function createFriendsModule(deps: FriendsModuleDeps): FriendsModule {
  const service = createFriendsService({
    repository: createFriendsRepository(deps.db),
    publisher: deps.publisher,
    avatarUrl: deps.avatarUrl,
  });
  const router = createFriendsRouter({
    controller: createFriendsController(service),
    requireAuth: deps.requireAuth,
    writeLimiter: deps.writeLimiter,
  });
  return { router, reader: createFriendshipReader(deps.db) };
}
