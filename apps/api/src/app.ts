import type { CsrfTokenResponse } from '@app/shared';
import cookieParser from 'cookie-parser';
import { eq } from 'drizzle-orm';
import express, { type Express, type RequestHandler, type Router } from 'express';
import type { Logger } from 'pino';

import { cookiesAreSecure, type Env } from './config/env.js';
import type { Limits } from './config/limits.js';
import type { Database } from './db/client.js';
import { users } from './db/schema/index.js';
import { toUserSummary, userSummaryColumns } from './db/selections.js';
import { createAuthModule } from './features/auth/index.js';
import { createAvatarsModule } from './features/avatars/index.js';
import { createChatModule } from './features/chat/index.js';
import { createFriendsModule } from './features/friends/index.js';
import { createPresenceModule } from './features/presence/index.js';
import { createUsersModule } from './features/users/index.js';
import { createWallModule } from './features/wall/index.js';
import { requireAuth } from './shared/auth/guards.js';
import type { PasswordHasher } from './shared/auth/password.js';
import { createHealthRouter, createReadinessHandler, type ReadinessChecks } from './shared/http/health.js';
import { errorHandler, notFoundHandler } from './shared/http/problem.js';
import { createRequestLogger } from './shared/logging/logger.js';
import { createAvatarUrl, type AvatarUrl } from './shared/media/media-url.js';
import type { SocketEventLimiter } from './shared/realtime/event-limiter.js';
import type { SessionGuard } from './shared/realtime/session-guard.js';
import { registerSocketHandlers } from './shared/realtime/socket-server.js';
import type { AppServer, RealtimePublisher, UserSummaryLoader } from './shared/realtime/types.js';
import type { RedisClient } from './shared/redis/redis.js';
import { bindAnonymousSession, createCsrf, freshTokenIssuer } from './shared/security/csrf.js';
import { createLoginLimiters } from './shared/security/login-limiters.js';
import {
  corsAllowList,
  createGlobalLimiter,
  rateLimiter,
  type RateLimitStoreFactory,
  securityHeaders,
  userLimitKey,
} from './shared/security/security.js';
import { sessionCookieName } from './shared/security/session.js';
import type { ObjectStorage } from './shared/storage/object-storage.js';

/** The Redis fixed-window limiters of socket traffic (OVERVIEW §10), built by `createAppDeps` in container.ts. */
export interface SocketLimiters {
  /** `limits.socketHandshake` per IP, Redis name `ws-handshake`. */
  handshake: SocketEventLimiter;
  /** `limits.chatSend` per user, Redis name `chat-send`. */
  chatSend: SocketEventLimiter;
  /** `limits.wallJoin` per user, Redis name `wall-join`. */
  wallJoin: SocketEventLimiter;
}

/**
 * Everything the app needs from the outside world. `container.ts` builds the real one; `test/test-app.ts` builds one
 * with the same `createAppDeps` wiring on the test file's own database, with fake storage, multiplied limits and its
 * own `test-<uuid>` key prefix.
 */
export interface AppDeps {
  env: Env;
  logger: Logger;
  db: Database;
  redis: RedisClient;
  storage: ObjectStorage;
  /** express-session with the Redis store; `attachSocketServer` runs the same middleware on socket upgrades. */
  session: RequestHandler;
  hasher: PasswordHasher;
  timingDummyHash: string;
  /** Every HTTP limit (`resolveLimits(env)` in production; tests may pass exact values). */
  limits: Limits;
  rateLimitStores: RateLimitStoreFactory;
  socketLimiters: SocketLimiters;
  /** Redis namespace of everything the app keys there: `APP_SLUG` in production, `test-<uuid>` per test app. */
  keyPrefix: string;
  /** This process in the shared presence sets (ADR-0009). */
  instanceId: string;
  /** The typed socket.io server, not yet attached; `server.ts` (or the test app) attaches it to the HTTP server. */
  io: AppServer;
  publisher: RealtimePublisher;
  sessionGuard: SessionGuard;
  readiness: ReadinessChecks;
  isShuttingDown: () => boolean;
  /**
   * Test-only routes (`POST /__test/sign-in`, ADR-0019 §3). Only `createTestApp()` passes them; `container.ts` cannot
   * (its return type excludes the key), so the production app never mounts them.
   */
  testRoutes?: Router;
}

export interface AppInstance {
  app: Express;
  /**
   * Startup work that must finish before the server accepts connections: presence clears its stale keys. `server.ts`
   * awaits it before `listen`; the test app awaits it too.
   */
  onBoot: () => Promise<void>;
}

/** The handshake's one user lookup per socket (B-75). Public fields only, through the shared selection (B-19). */
function createUserSummaryLoader(db: Database, avatarUrl: AvatarUrl): UserSummaryLoader {
  return async (userId) => {
    const [row] = await db.select(userSummaryColumns).from(users).where(eq(users.id, userId)).limit(1);
    return row ? toUserSummary(row, avatarUrl) : null;
  };
}

/**
 * Builds the HTTP app and registers the socket handlers on `deps.io` (OVERVIEW §3, express-feature-module):
 * settings → request logger → health → helmet → CORS → body parsers (100 kb) → session → cookie-parser → global
 * limiter → `GET /api/csrf-token` → test routes (test apps only) → CSRF protection → feature routers → 404 → errors.
 *
 * Every limiter is created here, once, from `deps.limits`; none is created inside a request.
 */
export function createApp(deps: AppDeps): AppInstance {
  const { env, logger, db, limits, rateLimitStores: stores } = deps;
  const secure = cookiesAreSecure(env);
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'simple');

  app.use(createRequestLogger(logger));
  // Before helmet, sessions and limits: probes stay cheap and are never rate limited (API.md, Infrastructure).
  const health = { checks: deps.readiness, isShuttingDown: deps.isShuttingDown, logger };
  app.use('/health', createHealthRouter(health));
  app.get('/api/health', createReadinessHandler(health)); // F-114

  app.use(securityHeaders());
  app.use(corsAllowList(env.CORS_ORIGINS));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(deps.session);
  app.use(cookieParser()); // after express-session, as csrf-csrf recommends

  app.use(createGlobalLimiter(limits, stores, logger));
  const csrf = createCsrf({ secret: env.CSRF_SECRET, secure });
  app.get('/api/csrf-token', (req, res) => {
    bindAnonymousSession(req);
    const body: CsrfTokenResponse = { token: csrf.generateCsrfToken(req, res) };
    res.json(body);
  });
  // ADR-0019 §3: after the token route (a test signs in, then uses the returned token) and before CSRF protection
  // (the sign-in itself carries no token yet).
  if (deps.testRoutes) app.use(deps.testRoutes);
  app.use(csrf.doubleCsrfProtection);

  // Per-user limiters must run behind `requireAuth`; `userLimitKey` turns a mount before it into a loud 500.
  const perUser = (name: 'search' | 'write' | 'upload'): RequestHandler =>
    rateLimiter({ name, ...limits[name], store: stores(name), logger, keyGenerator: userLimitKey });
  // One budget for friendship and wall writes together (OVERVIEW §10).
  const writeLimiter = perUser('write');
  const avatarUrl = createAvatarUrl();
  const { publisher, sessionGuard, socketLimiters } = deps;

  // Created first: users and wall receive its reader (BUILD-ORDER 1b).
  const friends = createFriendsModule({ db, requireAuth, writeLimiter, publisher, avatarUrl });
  const auth = createAuthModule({
    db,
    hasher: deps.hasher,
    timingDummyHash: deps.timingDummyHash,
    requireAuth,
    authLimiter: rateLimiter({ name: 'auth', ...limits.auth, store: stores('auth'), logger }),
    loginLimiters: createLoginLimiters(limits, stores, logger),
    issueCsrfToken: freshTokenIssuer(csrf),
    sessionCookieName: sessionCookieName(secure),
    publisher,
  });
  const usersModule = createUsersModule({
    db,
    requireAuth,
    friendships: friends.reader,
    avatarUrl,
    searchLimiter: perUser('search'),
  });
  const avatars = createAvatarsModule({
    db,
    storage: deps.storage,
    requireAuth,
    uploadLimiter: perUser('upload'),
    maxUploadBytes: env.UPLOAD_MAX_BYTES,
    avatarUrl,
    logger: logger.child({ feature: 'avatars' }),
  });
  const wall = createWallModule({
    db,
    requireAuth,
    writeLimiter,
    friendships: friends.reader,
    publisher,
    avatarUrl,
    joinLimiter: socketLimiters.wallJoin,
    sessionGuard,
  });
  const chat = createChatModule({
    db,
    requireAuth,
    avatarUrl,
    chatLimiter: socketLimiters.chatSend,
    sessionGuard,
    logger: logger.child({ feature: 'chat' }),
  });
  const presence = createPresenceModule({
    db,
    redis: deps.redis,
    keyPrefix: deps.keyPrefix,
    requireAuth,
    avatarUrl,
    graceMs: env.PRESENCE_GRACE_MS,
    instanceId: deps.instanceId,
    logger: logger.child({ feature: 'presence' }),
  });

  // Auth is the only router with a prefix; every other one declares full sub-paths under /api and applies
  // `requireAuth` per route (BUILD-ORDER 1b).
  app.use('/api/auth', auth.router);
  for (const feature of [usersModule, avatars, friends, wall, chat, presence]) app.use('/api', feature.router);

  // Unknown paths, /api/* included, answer the 404 problem, never an HTML page (F-04, B-57).
  app.use(notFoundHandler);
  app.use(errorHandler);

  registerSocketHandlers(deps.io, {
    handshakeLimiter: socketLimiters.handshake,
    trustedHops: env.TRUST_PROXY,
    loadUser: createUserSummaryLoader(db, avatarUrl),
    // Presence first, so it counts every accepted socket before any other handler runs (ADR-0008).
    registrars: [presence.registerSocket, wall.registerSocket, chat.registerSocket],
    logger: logger.child({ module: 'realtime' }),
  });

  return { app, onBoot: () => presence.onBoot() };
}
