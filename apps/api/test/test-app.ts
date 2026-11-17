import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';
import { pino } from 'pino';
import { inject } from 'vitest';

import { createApp } from '../src/app.js';
import { cookiesAreSecure, loadEnv } from '../src/config/env.js';
import { resolveLimits, type Limits } from '../src/config/limits.js';
import { createAppDeps } from '../src/container.js';
import { createDatabase } from '../src/db/client.js';
import { argon2Hasher } from '../src/shared/auth/password.js';
import { attachSocketServer } from '../src/shared/realtime/socket-server.js';
import { createRedisClient } from '../src/shared/redis/redis.js';
import { createCsrf, freshTokenIssuer } from '../src/shared/security/csrf.js';
import { currentDatabaseUrl } from './database.js';
import { createFakeStorage } from './fakes.js';
import { createTestRoutes } from './test-routes.js';

/** The browser origin the test app allow-lists for CORS and the socket handshake; `connectAs` sends it by default. */
export const TEST_ORIGIN = 'http://127.0.0.1:5173';

/** Every limit × 100: all test traffic comes from one IP (ADR-0016). Limiter test files pass exact `limits`. */
export const TEST_RATE_LIMIT_MULTIPLIER = 100;

/**
 * argon2id (pinned parameters) of a throwaway string, used as the app's `timingDummyHash`: unknown-email logins verify
 * against a real argon2id hash as in production (F-15), without hashing at every `createTestApp()`.
 */
const TIMING_DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$5veH4iNx0TYpNAM48sWT0w$rLGq62z0n+kUpF3wwQxbTyp3Igrd/Sfby0Sla4nvwPk';

export interface TestAppOptions {
  /** Exact limits (limiter tests); defaults to `resolveLimits({ RATE_LIMIT_MULTIPLIER: 100 })`. */
  limits?: Limits;
  /** Redis namespace for sessions, limiters, presence and socket limiters; defaults to a fresh `test-<uuid>`. */
  keyPrefix?: string;
  /**
   * Mounts `POST /__test/sign-in` (default true). `false` builds the app exactly as the composition root does, which
   * `test/app.int.test.ts` uses to prove the route does not exist there (ADR-0019 §3).
   */
  testRoutes?: boolean;
  /**
   * Extra environment keys, validated by the real env schema (e.g. `PRESENCE_GRACE_MS: '200'` so a presence test does
   * not wait 5 s, or `UPLOAD_MAX_BYTES`). Connection URLs, secrets, `CORS_ORIGINS` and `COOKIE_SECURE` are the test
   * app's own and cannot be overridden.
   */
  env?: Readonly<
    Partial<Record<'PRESENCE_GRACE_MS' | 'UPLOAD_MAX_BYTES' | 'SESSION_TTL_DAYS' | 'TRUST_PROXY', string>>
  >;
}

function listen(server: HttpServer): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const { port } = server.address() as AddressInfo; // a TCP listener always reports an AddressInfo
      resolve(`http://127.0.0.1:${String(port)}`);
    });
  });
}

/**
 * The real app on the file's own database and the run's Redis (ADR-0016, ADR-0019 §5): the real `createApp` with every
 * module, the real socket.io server attached to an HTTP server on an ephemeral port, the real argon2 hasher, sessions
 * and limiters in Redis under a fresh key prefix, fake object storage and a silent logger. The wiring is the
 * production one (`createAppDeps` from `container.ts`); only the connections, the limits, the key prefix and
 * `testRoutes` differ.
 *
 * Call it in `beforeAll`/`beforeEach`, never at module top level (`currentDatabaseUrl()` throws there), and `close()`
 * it in the matching `afterAll`/`afterEach`. Use `request.agent(testApp.app)` for HTTP and `connectAs(agent, testApp)`
 * (test/socket.ts) for sockets: cookies ignore ports, so the agent's session cookie is valid at `baseUrl` too.
 */
export async function createTestApp({
  limits = resolveLimits({ RATE_LIMIT_MULTIPLIER: TEST_RATE_LIMIT_MULTIPLIER }),
  keyPrefix = `test-${randomUUID()}`,
  testRoutes = true,
  env: envOverrides = {},
}: TestAppOptions = {}) {
  const env = loadEnv({
    ...envOverrides,
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
    RATE_LIMIT_MULTIPLIER: String(TEST_RATE_LIMIT_MULTIPLIER),
  });
  const logger = pino({ level: 'silent' });
  const secure = cookiesAreSecure(env);
  const database = createDatabase(env.DATABASE_URL, { logger });
  const redis = createRedisClient({ url: env.REDIS_URL, logger });
  try {
    await redis.connect();
  } catch (error) {
    await database.close();
    throw error;
  }

  const storage = createFakeStorage();
  // Same secret and cookie as the app's own CSRF instance (both from `createCsrf`), so tokens issued here pass its
  // `doubleCsrfProtection`.
  const csrf = createCsrf({ secret: env.CSRF_SECRET, secure });

  // Construction only, no I/O: the production wiring around this file's connections.
  const deps = createAppDeps({ env, logger, database, redis, storage, keyPrefix, limits });
  const { io, sessionGuard } = deps;

  let app: Express;
  let httpServer: HttpServer;
  let baseUrl: string;
  try {
    const built = createApp({
      env,
      logger,
      ...deps,
      hasher: argon2Hasher,
      timingDummyHash: TIMING_DUMMY_HASH,
      isShuttingDown: () => false,
      ...(testRoutes
        ? {
            testRoutes: createTestRoutes({ db: database.db, issueCsrfToken: freshTokenIssuer(csrf) }),
          }
        : {}),
    });
    app = built.app;
    httpServer = createServer(app);
    attachSocketServer(io, httpServer, deps.session);
    // As in server.ts: presence clears this prefix's stale keys before the first socket can connect.
    await built.onBoot();
    baseUrl = await listen(httpServer);
  } catch (error) {
    // Nothing may outlive a failed build: the setup file drops the database next, and Redis is shared by the run.
    await Promise.allSettled([io.close(), database.close(), redis.close()]);
    throw error;
  }

  let closing: Promise<void> | undefined;

  return {
    /** The Express app: `request(app)` / `request.agent(app)`. */
    app,
    /** The listening HTTP server that io is attached to. */
    httpServer,
    /** `http://127.0.0.1:<ephemeral port>`; sockets connect here (`connectAs`). */
    baseUrl,
    io,
    db: database.db,
    redis,
    /** Redis is shared by every file of the run: everything this app keys in Redis starts with `<prefix>:`. */
    prefix: keyPrefix,
    /** `sessionGuard.sweep()` runs the 60 s session sweep on demand (the interval lives in server.ts). */
    sessionGuard,
    /** The fake object storage behind the avatar routes (inspect objects, `fail('put')`). */
    storage,
    /**
     * Closes io (every socket, the engine and the HTTP server), then the pool and Redis (a test may have closed Redis
     * already). Idempotent. The setup file drops the database afterwards.
     */
    close(): Promise<void> {
      closing ??= (async () => {
        httpServer.closeIdleConnections();
        await io.close();
        await Promise.all([database.close(), redis.isOpen ? redis.close() : Promise.resolve()]);
      })();
      return closing;
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
