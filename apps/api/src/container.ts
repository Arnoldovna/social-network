import type { Logger } from 'pino';

import type { Env } from './config/env.js';
import { createDatabase } from './db/client.js';
import { createRedisClient } from './shared/redis/redis.js';

/**
 * Composition root: the only place that opens connections. Everything else receives its dependencies as arguments,
 * so there are no module-level singletons. Phase-1a skeleton: Postgres and Redis for readiness. Phase 1b adds S3
 * storage, sessions, the hasher, rate-limit stores and the realtime server.
 */
export async function createContainer(env: Env, logger: Logger) {
  const database = createDatabase(env.DATABASE_URL, { logger });
  const redis = createRedisClient({ url: env.REDIS_URL, logger });
  try {
    // Rejects after a few retries when Redis is unreachable, so startup fails fast with exit 1 (redis.ts).
    await redis.connect();
  } catch (error) {
    await database.close();
    throw error;
  }

  return {
    db: database.db,
    redis,
    readiness: {
      database: () => database.ping(),
      redis: () => Promise.resolve(redis.isReady),
    },
    async dispose(): Promise<void> {
      await Promise.allSettled([database.close(), redis.isOpen ? redis.close() : Promise.resolve()]);
    },
  };
}

export type Container = Awaited<ReturnType<typeof createContainer>>;
