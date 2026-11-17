import { type RequestHandler, Router } from 'express';

import type { UsersController } from './users.controller.js';

export interface UsersRouteDeps {
  controller: UsersController;
  requireAuth: RequestHandler;
  /** Per-user search limiter (60/min); it keys by user id, so it must run after `requireAuth`. */
  searchLimiter: RequestHandler;
}

/**
 * Mounted at `/api` (API.md, "Profile and users"). `requireAuth` is applied per route, never router-wide, so this
 * router never answers 401 for paths of other features mounted after it. CSRF protection for `PATCH /me` runs
 * app-wide before every feature router.
 */
export function createUsersRouter({ controller, requireAuth, searchLimiter }: UsersRouteDeps): Router {
  const router = Router();
  router.get('/me', requireAuth, controller.getMe);
  router.patch('/me', requireAuth, controller.updateMe);
  // Registered before `/users/:id`, so `search` is never parsed as an id (API.md).
  router.get('/users/search', requireAuth, searchLimiter, controller.search);
  router.get('/users/:id', requireAuth, controller.getProfile);
  return router;
}
