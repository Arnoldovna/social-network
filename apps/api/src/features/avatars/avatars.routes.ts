import { type RequestHandler, Router } from 'express';

import type { AvatarsController } from './avatars.controller.js';

export interface AvatarsRouteDeps {
  controller: AvatarsController;
  requireAuth: RequestHandler;
  uploadLimiter: RequestHandler;
  /** multer for the single `avatar` part (`avatarUpload`). */
  upload: RequestHandler;
}

/**
 * Mounted at `/api`. CSRF protection runs globally before every router (app.ts). The upload pipeline is ordered so
 * that nothing is parsed or stored for a visitor (B-35): `requireAuth` → per-user `uploadLimiter` → multer → handler.
 */
export function createAvatarsRouter({ controller, requireAuth, uploadLimiter, upload }: AvatarsRouteDeps): Router {
  const router = Router();
  router.put('/me/avatar', requireAuth, uploadLimiter, upload, controller.upload);
  // Also answers HEAD (without reading the object body). The global limiter skips this route
  // (shared/security/security.ts, ADR-0010 §10).
  router.get('/users/:id/avatar', requireAuth, controller.show);
  return router;
}
