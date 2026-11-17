// Public API of the avatars feature (BUILD-ORDER "Module signatures fixed in Phase 1b"). The composition root imports
// only from here. Phase 1b stub: the signature is final, the Phase 2 avatars unit fills the body and keeps every
// exported name and type.
import { Router, type RequestHandler } from 'express';
import type { Logger } from 'pino';

import type { Database } from '../../db/client.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { ObjectStorage } from '../../shared/storage/object-storage.js';

export interface AvatarsModuleDeps {
  db: Database;
  storage: ObjectStorage;
  requireAuth: RequestHandler;
  /** Avatar uploads per user (`limits.upload`). */
  uploadLimiter: RequestHandler;
  /** `UPLOAD_MAX_BYTES`, at most the shared `AVATAR_MAX_BYTES`. */
  maxUploadBytes: number;
  avatarUrl: AvatarUrl;
  /** A failed delete of a replaced object is logged as a warning, never an error response (F-39). */
  logger: Logger;
}

export interface AvatarsModule {
  /** Mounted at `/api`; declares `PUT /me/avatar` and `GET /users/:id/avatar`. */
  router: Router;
}

export function createAvatarsModule(_deps: AvatarsModuleDeps): AvatarsModule {
  return { router: Router() };
}
