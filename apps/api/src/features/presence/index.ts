// Public API of the presence feature (BUILD-ORDER "Module signatures fixed in Phase 1b"). The composition root imports
// only from here (enforced by eslint-plugin-boundaries).
import type { RequestHandler, Router } from 'express';
import type { Logger } from 'pino';

import type { Database } from '../../db/client.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { RedisClient } from '../../shared/redis/redis.js';
import type { SocketRegistrar } from '../../shared/realtime/types.js';
import { createPresenceController } from './presence.controller.js';
import { createPresenceRepository } from './presence.repository.js';
import { createPresenceRouter } from './presence.routes.js';
import { createPresenceService } from './presence.service.js';
import { createPresenceSocket } from './presence.socket.js';
import { createRedisPresenceStore } from './presence.store.js';

export interface PresenceModuleDeps {
  db: Database;
  redis: RedisClient;
  /** Redis namespace of the presence keys (`<keyPrefix>:presence:*`): `APP_SLUG`, or `test-<uuid>` per test app. */
  keyPrefix: string;
  requireAuth: RequestHandler;
  avatarUrl: AvatarUrl;
  /** `PRESENCE_GRACE_MS`: how long a user stays online after their last socket closed (F-87, ADR-0009). */
  graceMs: number;
  /** Distinguishes this process' sockets in the shared presence sets (`<instanceId>:<socketId>`, ADR-0009). */
  instanceId: string;
  logger: Logger;
}

export interface PresenceModule {
  /** Mounted at `/api`; declares `/presence`. */
  router: Router;
  /** Registered first, so presence sees every accepted socket (ADR-0008). */
  registerSocket: SocketRegistrar;
  /** Clears this namespace's stale presence keys; `server.ts` awaits it before accepting connections. */
  onBoot(): Promise<void>;
}

/** Construction only, no I/O: Redis is first touched by `onBoot()` and by the first socket. */
export function createPresenceModule(deps: PresenceModuleDeps): PresenceModule {
  const service = createPresenceService({
    store: createRedisPresenceStore({ redis: deps.redis, keyPrefix: deps.keyPrefix }),
    repository: createPresenceRepository(deps.db),
    avatarUrl: deps.avatarUrl,
    graceMs: deps.graceMs,
    logger: deps.logger,
  });
  const router = createPresenceRouter({
    controller: createPresenceController(service),
    requireAuth: deps.requireAuth,
  });
  const registerSocket = createPresenceSocket({ service, instanceId: deps.instanceId, logger: deps.logger });
  return { router, registerSocket, onBoot: () => service.reset() };
}
