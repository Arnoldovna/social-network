import cors from 'cors';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type Store, type ValueDeterminingMiddleware } from 'express-rate-limit';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { RedisStore, type RedisReply } from 'rate-limit-redis';

import type { RateLimit } from '../../config/limits.js';
import { TooManyRequestsError } from '../errors/app-error.js';
import type { RedisClient } from '../redis/redis.js';

const NONE = "'none'";

/**
 * Security headers for every API response after the health routes (F-109, B-59). The API never serves a document,
 * only JSON and avatar images, so its CSP denies everything instead of helmet's page-oriented defaults (which allow
 * `style-src 'unsafe-inline' https:`): a response opened directly in a browser can load nothing, submit nothing and
 * cannot be framed. The SPA's own CSP (`img-src 'self' data: blob:`, `connect-src 'self'`, no inline scripts) is set
 * by nginx (ADR-0017). The other helmet defaults stay: nosniff, same-origin CORP/COOP, HSTS, no referrer leaks.
 */
export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: [NONE],
        baseUri: [NONE],
        formAction: [NONE],
        frameAncestors: [NONE],
      },
    },
    frameguard: { action: 'deny' },
  });
}

/**
 * Explicit allow-list (B-07): never reflect arbitrary origins while credentials (cookies) are allowed. Same-origin
 * and non-browser requests carry no Origin header and pass; a foreign origin simply gets no CORS headers, so the
 * browser blocks the response.
 */
export function corsAllowList(origins: readonly string[]): RequestHandler {
  const allowed = new Set(origins);
  return cors({
    origin: (requestOrigin, callback) => {
      callback(null, requestOrigin === undefined || allowed.has(requestOrigin));
    },
    credentials: true,
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Rate limits (OVERVIEW §10, ADR-0006). The values come from config/limits.ts; the keys are decided here.
// ---------------------------------------------------------------------------------------------------------------

/** IPv6 clients are limited per /56, one customer prefix: rotating addresses inside it does not help (conventions §8). */
export const IPV6_SUBNET = 56;

/**
 * The IP part of every custom limiter key: IPv4 as is, IPv4-mapped IPv6 as its IPv4 form, other IPv6 addresses as their
 * /56 network. express-rate-limit ignores `ipv6Subnet` as soon as a custom `keyGenerator` is set, so every custom key
 * builds its IP part with this function (conventions §8). A request without an address (closed socket) gets `''`.
 */
export function clientIpKey(req: { readonly ip?: string | undefined }): string {
  return ipKeyGenerator(req.ip ?? '', IPV6_SUBNET);
}

/**
 * The Redis namespace of one limiter, `<prefix>:rl:<name>:`, shared by the HTTP stores below and the socket event
 * limiters (shared/realtime/event-limiter.ts), so both kinds of counters sit side by side.
 */
export function rateLimitKeyPrefix(prefix: string, name: string): string {
  return `${prefix}:rl:${name}:`;
}

/** A store factory: each limiter needs its own store with a distinct prefix (express-rate-limit `ERR_ERL_STORE_REUSE`). */
export type RateLimitStoreFactory = (name: string) => Store | undefined;

/**
 * Redis-backed counters under `<prefix>:rl:<name>:` (`social-network:rl:auth:` in production, `test-<uuid>:rl:...` in
 * tests), so limits survive restarts and hold across instances. The client must be connected before the first request.
 */
export function redisRateLimitStores(redis: RedisClient, prefix: string): RateLimitStoreFactory {
  return (name) =>
    new RedisStore({
      prefix: rateLimitKeyPrefix(prefix, name),
      sendCommand: (...args: string[]) => redis.sendCommand<RedisReply>(args),
    });
}

/** In-memory stores (express-rate-limit default) for unit tests. */
export const memoryRateLimitStores: RateLimitStoreFactory = () => undefined;

/** Receives express-rate-limit's own warnings and errors (`ERR_ERL_*`), which would otherwise go to the console. */
export type RateLimitLogger = Pick<Logger, 'warn' | 'error'>;

export interface RateLimitOptions extends RateLimit {
  /** Names the limiter in the `RateLimit-Policy` header and in log lines. */
  name: string;
  store?: Store | undefined;
  logger: RateLimitLogger;
  /** Custom key. Must build any IP part with `clientIpKey` (conventions §8). Default: the client IP, IPv6 per /56. */
  keyGenerator?: ValueDeterminingMiddleware<string>;
  /** Requests for which this returns true are neither counted nor limited. */
  skip?: ValueDeterminingMiddleware<boolean>;
  /** Count only failed responses (status >= 400), e.g. failed logins (ADR-0006). */
  skipSuccessfulRequests?: boolean;
}

/**
 * One express-rate-limit 8 instance: IETF draft-8 `RateLimit`/`RateLimit-Policy` headers, no legacy `X-RateLimit-*`
 * headers, `Retry-After` on rejection, and the rejection routed to the central error handler as `TooManyRequestsError`
 * (429 `rate-limited` problem+json, F-16). Create limiters at startup, never inside a request.
 */
export function rateLimiter({
  name,
  windowMs,
  limit,
  store,
  logger,
  keyGenerator,
  skip,
  skipSuccessfulRequests = false,
}: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    identifier: name,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // A custom keyGenerator and ipv6Subnet are mutually exclusive (ERR_ERL_IPV6SUBNET_OR_KEYGENERATOR).
    ...(keyGenerator ? { keyGenerator } : { ipv6Subnet: IPV6_SUBNET }),
    ...(skip ? { skip } : {}),
    skipSuccessfulRequests,
    ...(store ? { store } : {}),
    logger: {
      warn: (error, message) => {
        logger.warn({ err: error, limiter: name }, message ?? 'rate limiter warning');
      },
      error: (error, message) => {
        logger.error({ err: error, limiter: name }, message ?? 'rate limiter error');
      },
    },
    handler: (_req, _res, next) => {
      next(new TooManyRequestsError());
    },
  });
}

/**
 * The avatar image route (`GET /api/users/:id/avatar`, also answered for HEAD). A page renders one image per user it
 * lists, so these requests stay out of the global budget; they are cheap, cacheable reads of a private bucket.
 * Case-insensitive with an optional trailing slash, like Express' default routing.
 */
const AVATAR_IMAGE_PATH = /^\/api\/users\/\d+\/avatar\/?$/i;

export function isAvatarImageRequest(req: Pick<Request, 'method' | 'baseUrl' | 'path'>): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') && AVATAR_IMAGE_PATH.test(req.baseUrl + req.path);
}

interface SessionRequest {
  readonly ip?: string | undefined;
  readonly session: { readonly userId?: number | undefined };
}

const userKey = (userId: number): string => `u:${String(userId)}`;

/**
 * Key of the global limiter: `u:<userId>` for a signed-in session (one budget per user across devices and networks,
 * and users behind one NAT do not share a budget), the client IP otherwise. An IP key never starts with `u:`.
 */
export function globalLimitKey(req: SessionRequest): string {
  const { userId } = req.session;
  return userId === undefined ? clientIpKey(req) : userKey(userId);
}

/**
 * Key of the per-user limiters (`search`, `write`, `upload`): `u:<userId>`. They are mounted after `requireAuth`, so a
 * request without a signed-in user here is a wiring bug. It fails loudly (500, logged with the stack) instead of
 * quietly falling back to an IP budget that every user behind one NAT would share.
 */
export function userLimitKey(req: Pick<SessionRequest, 'session'>): string {
  const { userId } = req.session;
  if (userId === undefined)
    throw new Error('A per-user rate limiter ran without a signed-in user (before requireAuth).');
  return userKey(userId);
}

/**
 * The app-wide limiter (300 / min in production), mounted after the session middleware and before CSRF protection.
 * Redis store `global`.
 */
export function createGlobalLimiter(
  limits: { readonly global: RateLimit },
  stores: RateLimitStoreFactory,
  logger: RateLimitLogger,
): RequestHandler {
  return rateLimiter({
    name: 'global',
    ...limits.global,
    store: stores('global'),
    logger,
    keyGenerator: globalLimitKey,
    skip: isAvatarImageRequest,
  });
}
