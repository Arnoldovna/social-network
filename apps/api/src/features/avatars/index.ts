// Public API of the avatars feature (BUILD-ORDER "Module signatures fixed in Phase 1b"). The composition root imports
// only from here.
import { AVATAR_FIELD } from '@app/shared';
import type { RequestHandler, Router } from 'express';
import type { Logger } from 'pino';

import type { Database } from '../../db/client.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { ObjectStorage } from '../../shared/storage/object-storage.js';
import { processAvatar } from '../../shared/uploads/process-image.js';
import { avatarUpload } from '../../shared/uploads/upload.js';
import { createAvatarsController } from './avatars.controller.js';
import { createAvatarsRepository } from './avatars.repository.js';
import { createAvatarsRouter } from './avatars.routes.js';
import { createAvatarsService } from './avatars.service.js';

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

/** Construction only: no I/O, nothing that can throw at import or creation time (BUILD-ORDER rule 7). */
export function createAvatarsModule(deps: AvatarsModuleDeps): AvatarsModule {
  const service = createAvatarsService({
    repository: createAvatarsRepository(deps.db),
    storage: deps.storage,
    avatarUrl: deps.avatarUrl,
    processImage: processAvatar,
    logger: deps.logger,
  });
  const router = createAvatarsRouter({
    controller: createAvatarsController(service),
    requireAuth: deps.requireAuth,
    uploadLimiter: deps.uploadLimiter,
    upload: avatarUpload(AVATAR_FIELD, deps.maxUploadBytes),
  });
  return { router };
}
