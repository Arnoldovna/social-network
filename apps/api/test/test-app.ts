import { randomUUID } from 'node:crypto';

import { pino } from 'pino';
import { inject } from 'vitest';

import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/client.js';
import { createRedisClient } from '../src/shared/redis/redis.js';
import { currentDatabaseUrl } from './database.js';

/** The browser origin the test app allow-lists (CORS now, the socket handshake from phase 1b on). */
export const TEST_ORIGIN = 'http://127.0.0.1:5173';

export interface TestAppOptions {
  /** Redis key prefix for everything this app keys in Redis; defaults to a fresh `test-<uuid>`. */
  keyPrefix?: string;
}

/**
 * The real app on the file's own database and the run's Redis (ADR-0016, ADR-0019 §5), with a silent logger.
 * Phase-1a skeleton: phase 1b extends it to `createTestApp({ limits?, keyPrefix?, testRoutes? })` returning
 * `{ app, httpServer, baseUrl, io, db, redis, prefix, sessionGuard, close }` (sessions, limits, fake storage, io and
 * the test-only sign-in route).
 *
 * Call it in `beforeAll`/`beforeEach`, never at module top level (currentDatabaseUrl() throws there), and `close()`
 * it in the matching `afterAll`/`afterEach`.
 */
export async function createTestApp({ keyPrefix = `test-${randomUUID()}` }: TestAppOptions = {}) {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    COOKIE_SECURE: 'false',
    DATABASE_URL: currentDatabaseUrl(),
    REDIS_URL: inject('redisUrl'),
    SESSION_SECRET: 'test-session-secret-with-at-least-32-chars',
    CSRF_SECRET: 'test-csrf-secret-with-at-least-32-characters',
    CORS_ORIGINS: TEST_ORIGIN,
    S3_BUCKET: 'test-bucket',
    S3_ACCESS_KEY_ID: 'test',
    S3_SECRET_ACCESS_KEY: 'test',
  });
  const logger = pino({ level: 'silent' });
  const database = createDatabase(env.DATABASE_URL, { logger });
  const redis = createRedisClient({ url: env.REDIS_URL, logger });
  try {
    await redis.connect();
  } catch (error) {
    await database.close();
    throw error;
  }

  const app = createApp({
    env,
    logger,
    readiness: {
      database: () => database.ping(),
      redis: () => Promise.resolve(redis.isReady),
    },
    isShuttingDown: () => false,
  });

  return {
    app,
    db: database.db,
    redis,
    /** Redis is shared by every file of the run: anything this app keys in Redis goes under this prefix. */
    prefix: keyPrefix,
    /** Ends the pool and the Redis client (a test may have closed Redis already); the setup file drops the database. */
    async close(): Promise<void> {
      await Promise.all([database.close(), redis.isOpen ? redis.close() : Promise.resolve()]);
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
