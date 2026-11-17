// Public API of the presence feature (BUILD-ORDER "Module signatures fixed in Phase 1b"). The composition root imports
// only from here. Phase 1b stub: the signature is final, the Phase 2 presence unit fills the body and keeps every
// exported name and type.
import { Router, type RequestHandler } from 'express';
import type { Logger } from 'pino';

import type { Database } from '../../db/client.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { RedisClient } from '../../shared/redis/redis.js';
import type { SocketRegistrar } from '../../shared/realtime/types.js';

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

export function createPresenceModule(_deps: PresenceModuleDeps): PresenceModule {
  return { router: Router(), registerSocket: () => undefined, onBoot: () => Promise.resolve() };
}
