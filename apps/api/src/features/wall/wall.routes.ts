import { type RequestHandler, Router } from 'express';

import type { WallController } from './wall.controller.js';

export interface WallRouteDeps {
  controller: WallController;
  requireAuth: RequestHandler;
  /** `limits.write` per user, shared with the friends module; keyed by user, so it runs behind `requireAuth`. */
  writeLimiter: RequestHandler;
}

/**
 * Mounted at `/api` with full sub-paths (BUILD-ORDER 1b). `requireAuth` on every route (401 before anything else,
 * B-20); both mutations count against the write limiter. CSRF protection runs app-wide before this router (F-23).
 */
export function createWallRouter({ controller, requireAuth, writeLimiter }: WallRouteDeps): Router {
  const router = Router();
  router.get('/users/:id/posts', requireAuth, controller.list);
  router.post('/users/:id/posts', requireAuth, writeLimiter, controller.create);
  router.delete('/posts/:id', requireAuth, writeLimiter, controller.remove);
  return router;
}
