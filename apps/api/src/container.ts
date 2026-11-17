import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import type { AppDeps, SocketLimiters } from './app.js';
import { APP_SLUG } from './config/app.js';
import { cookiesAreSecure, type Env } from './config/env.js';
import { resolveLimits, type Limits } from './config/limits.js';
import { createDatabase, type DatabaseHandle } from './db/client.js';
import { argon2Hasher, createTimingDummy } from './shared/auth/password.js';
import { createRedisSocketEventLimiter } from './shared/realtime/event-limiter.js';
import { createRealtimePublisher } from './shared/realtime/publisher.js';
import { createSessionGuard } from './shared/realtime/session-guard.js';
import { createSocketServer } from './shared/realtime/socket-server.js';
import { createRedisClient, type RedisClient } from './shared/redis/redis.js';
import { redisRateLimitStores } from './shared/security/security.js';
import { createSessionMiddleware } from './shared/security/session.js';
import { createS3Storage, type ObjectStorage } from './shared/storage/object-storage.js';

/** The three socket limiters in Redis under `<prefix>:rl:<name>:` (OVERVIEW §10). */
function createSocketLimiters({
  redis,
  prefix,
  limits,
}: {
  redis: RedisClient;
  prefix: string;
  limits: Pick<Limits, 'socketHandshake' | 'chatSend' | 'wallJoin'>;
}): SocketLimiters {
  return {
    handshake: createRedisSocketEventLimiter({ redis, prefix, name: 'ws-handshake', ...limits.socketHandshake }),
    chatSend: createRedisSocketEventLimiter({ redis, prefix, name: 'chat-send', ...limits.chatSend }),
    wallJoin: createRedisSocketEventLimiter({ redis, prefix, name: 'wall-join', ...limits.wallJoin }),
  };
}

export interface AppDepsInput {
  env: Env;
  logger: Logger;
  database: DatabaseHandle;
  /** Must be connected: the rate-limit stores and the session store use it from the first request. */
  redis: RedisClient;
  storage: ObjectStorage;
  /** Redis namespace: `APP_SLUG` in production, `test-<uuid>` per test app. */
  keyPrefix: string;
  limits: Limits;
}

/** What `createAppDeps` builds: every `AppDeps` member that is derived from the open connections. */
export type ConnectedDeps = Omit<
  AppDeps,
  'env' | 'logger' | 'hasher' | 'timingDummyHash' | 'isShuttingDown' | 'testRoutes'
>;

/**
 * The wiring between the open connections and `createApp` (ADR-0008): session middleware, the unattached socket.io
 * server with its publisher and session guard, the HTTP and socket limiter stores and the readiness checks. Shared by
 * `createContainer` and `test/test-app.ts`, so integration tests run exactly the production wiring and only swap the
 * connections, the limits and the key prefix.
 */
export function createAppDeps({
  env,
  logger,
  database,
  redis,
  storage,
  keyPrefix,
  limits,
}: AppDepsInput): ConnectedDeps {
  const io = createSocketServer({ allowedOrigins: env.CORS_ORIGINS });
  return {
    db: database.db,
    redis,
    storage,
    session: createSessionMiddleware({
      redis,
      secret: env.SESSION_SECRET,
      secure: cookiesAreSecure(env),
      prefix: keyPrefix,
      ttlDays: env.SESSION_TTL_DAYS,
    }),
    limits,
    rateLimitStores: redisRateLimitStores(redis, keyPrefix),
    socketLimiters: createSocketLimiters({ redis, prefix: keyPrefix, limits }),
    keyPrefix,
    instanceId: randomUUID(),
    io,
    publisher: createRealtimePublisher(io),
    sessionGuard: createSessionGuard({ io, redis, prefix: keyPrefix, logger: logger.child({ module: 'realtime' }) }),
    readiness: {
      database: () => database.ping(),
      redis: () => Promise.resolve(redis.isReady),
      // The probe's signal cancels a HeadBucket that outlives the check timeout.
      storage: (signal) => storage.isReady(signal),
    },
  };
}

/**
 * What the composition root hands to `createApp` (with `env`, `logger` and `isShuttingDown` from `server.ts`) plus
 * `dispose`. `testRoutes` is excluded by the type, so the production app can never mount the test-only sign-in route
 * (ADR-0019 §3).
 */
export type Container = Omit<AppDeps, 'env' | 'logger' | 'isShuttingDown' | 'testRoutes'> & {
  /** Closes the pool, Redis and the S3 client. io is closed before, by `server.ts` (it also closes the HTTP server). */
  dispose(): Promise<void>;
};

/**
 * Composition root: the only place that opens connections (Postgres, Redis, S3). Everything else receives its
 * dependencies as arguments, so there are no module-level singletons. The socket.io server is created here, not yet
 * attached, so the publisher and the session guard exist before the HTTP server does (ADR-0008).
 */
export async function createContainer(env: Env, logger: Logger): Promise<Container> {
  const database = createDatabase(env.DATABASE_URL, { logger });
  const redis = createRedisClient({ url: env.REDIS_URL, logger });
  const storage = createS3Storage(env);
  const closeAll = async (): Promise<void> => {
    await Promise.allSettled([database.close(), redis.isOpen ? redis.close() : Promise.resolve()]);
    storage.client.destroy();
  };

  try {
    // Rejects after a few retries when Redis is unreachable, so startup fails fast with exit 1 (redis.ts).
    await redis.connect();

    return {
      ...createAppDeps({ env, logger, database, redis, storage, keyPrefix: APP_SLUG, limits: resolveLimits(env) }),
      hasher: argon2Hasher,
      timingDummyHash: await createTimingDummy(argon2Hasher),
      dispose: closeAll,
    };
  } catch (error) {
    await closeAll();
    throw error;
  }
}
