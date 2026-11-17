// Public API of the users feature (BUILD-ORDER "Module signatures fixed in Phase 1b"). The composition root imports
// only from here. Phase 1b stub: the signature is final, the Phase 2 users unit fills the body and keeps every exported
// name and type.
import { Router, type RequestHandler } from 'express';

import type { Database } from '../../db/client.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { FriendshipReader } from '../../shared/ports/friendship-reader.js';

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

export function createUsersModule(_deps: UsersModuleDeps): UsersModule {
  return { router: Router() };
}
