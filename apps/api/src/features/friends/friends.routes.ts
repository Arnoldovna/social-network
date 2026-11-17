import { type RequestHandler, Router } from 'express';

import type { FriendsController } from './friends.controller.js';

export interface FriendsRouteDeps {
  controller: FriendsController;
  requireAuth: RequestHandler;
  /** Per-user budget shared with the wall writes (60 / 10 min); keyed by user, so it must run after `requireAuth`. */
  writeLimiter: RequestHandler;
}

/**
 * Mounted at `/api` (BUILD-ORDER 1b): full sub-paths, `requireAuth` per route. CSRF protection runs app-wide before
 * every router, so each mutation below already needs a valid `x-csrf-token` (F-23).
 */
export function createFriendsRouter({ controller, requireAuth, writeLimiter }: FriendsRouteDeps): Router {
  const router = Router();
  router.get('/friendships', requireAuth, controller.list);
  router.post('/friendships', requireAuth, writeLimiter, controller.send);
  router.post('/friendships/:userId/accept', requireAuth, writeLimiter, controller.accept);
  router.delete('/friendships/:userId', requireAuth, writeLimiter, controller.remove);
  return router;
}
