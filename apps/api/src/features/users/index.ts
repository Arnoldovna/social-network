// Public API of the users feature (BUILD-ORDER "Module signatures fixed in Phase 1b"). The composition root imports
// only from here. The signature is frozen; the body wires repository -> service -> controller -> router.
import type { Router, RequestHandler } from 'express';

import type { Database } from '../../db/client.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { FriendshipReader } from '../../shared/ports/friendship-reader.js';
import { createUsersController } from './users.controller.js';
import { createUsersRepository } from './users.repository.js';
import { createUsersRouter } from './users.routes.js';
import { createUsersService } from './users.service.js';

export interface UsersModuleDeps {
  db: Database;
  requireAuth: RequestHandler;
  /** The friends module's reader: `relationship.state` and the wall flags of a profile (F-45, F-65). */
  friendships: FriendshipReader;
  avatarUrl: AvatarUrl;
  /** User search per user (`limits.search`). */
  searchLimiter: RequestHandler;
}

export interface UsersModule {
  /** Mounted at `/api`; declares `/me`, `/users/search` and `/users/:id` (search before `:id`). */
  router: Router;
}

export function createUsersModule(deps: UsersModuleDeps): UsersModule {
  const service = createUsersService({
    repository: createUsersRepository(deps.db),
    friendships: deps.friendships,
    avatarUrl: deps.avatarUrl,
  });
  const router = createUsersRouter({
    controller: createUsersController(service),
    requireAuth: deps.requireAuth,
    searchLimiter: deps.searchLimiter,
  });
  return { router };
}
