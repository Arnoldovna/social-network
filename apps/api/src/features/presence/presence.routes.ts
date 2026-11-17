import { Router, type RequestHandler } from 'express';

import type { PresenceController } from './presence.controller.js';

export interface PresenceRouteDeps {
  controller: PresenceController;
  requireAuth: RequestHandler;
}

/**
 * Mounted at `/api` (BUILD-ORDER 1b): full sub-paths, `requireAuth` per route. Read-only, so no CSRF token is needed;
 * the global limiter applies.
 */
export function createPresenceRouter({ controller, requireAuth }: PresenceRouteDeps): Router {
  const router = Router();
  router.get('/presence', requireAuth, controller.list);
  return router;
}
