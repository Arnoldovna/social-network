import { createHash } from 'node:crypto';

import type { RequestHandler } from 'express';

import type { Limits, RateLimit } from '../../config/limits.js';
import { clientIpKey, rateLimiter, type RateLimitLogger, type RateLimitStoreFactory } from './security.js';

/**
 * The two failed-login limiters of ADR-0006 (F-16, B-15). Both count only failed responses (status >= 400), so a
 * successful login never uses up its owner's budget, and both answer 429 `rate-limited` with `Retry-After`.
 */
export interface LoginLimiters {
  /** 5 failed / 15 min per `sha256(lower(email))` + client IP (/56): Redis store `login-email-ip`. */
  readonly strict: RequestHandler;
  /** 50 failed / h per `sha256(lower(email))` from any source: Redis store `login-email`. */
  readonly ceiling: RequestHandler;
  /**
   * Both in the order the login route mounts them (`router.post('/login', authLimiter, ...loginLimiters.chain, ...)`),
   * after `authLimiter` and before validation. Strict runs first: a
   * request it rejects never reaches the ceiling, so one source adds at most 5 per 15 min to an account's shared
   * ceiling and cannot lock the owner out everywhere on its own.
   */
  readonly chain: readonly [RequestHandler, RequestHandler];
}

/** The parts of a request the key functions read; `body` is unvalidated because the limiters run before `validate()`. */
interface LoginRequest {
  readonly ip?: string | undefined;
  readonly body?: unknown;
}

/** `req.body.email` normalised like the shared email schema (trim, lower case), or undefined when there is none. */
function bodyEmail({ body }: LoginRequest): string | undefined {
  if (typeof body !== 'object' || body === null || !('email' in body) || typeof body.email !== 'string') {
    return undefined;
  }
  const email = body.email.trim().toLowerCase();
  return email.length > 0 ? email : undefined;
}

/**
 * `sha256(lower(email))` as hex, so the Redis key never holds the address in clear text. Undefined when the body has no
 * email: such a request cannot be an attempt on an account (validation rejects it with 422) and is not counted here;
 * `authLimiter` (per IP) still limits it.
 */
export function loginEmailKey(req: LoginRequest): string | undefined {
  const email = bodyEmail(req);
  return email === undefined ? undefined : createHash('sha256').update(email).digest('hex');
}

/** Key of the strict limiter: the email hash plus the client IP (/56), so an attacker cannot lock out the owner. */
export function loginStrictKey(req: LoginRequest): string {
  return `${loginEmailKey(req) ?? ''}:${clientIpKey(req)}`;
}

/** Key of the ceiling: the email hash alone. */
export function loginCeilingKey(req: LoginRequest): string {
  return loginEmailKey(req) ?? '';
}

const withoutEmail = (req: LoginRequest): boolean => loginEmailKey(req) === undefined;

/**
 * Builds both limiters once at startup with their production (or test) values from `limits` (`loginStrict`,
 * `loginCeiling`) and one store each.
 */
export function createLoginLimiters(
  limits: Pick<Limits, 'loginStrict' | 'loginCeiling'>,
  stores: RateLimitStoreFactory,
  logger: RateLimitLogger,
): LoginLimiters {
  const failedLogins = (name: string, limit: RateLimit, keyGenerator: (req: LoginRequest) => string): RequestHandler =>
    rateLimiter({
      name,
      ...limit,
      store: stores(name),
      logger,
      keyGenerator,
      skip: withoutEmail,
      skipSuccessfulRequests: true,
    });
  const strict = failedLogins('login-email-ip', limits.loginStrict, loginStrictKey);
  const ceiling = failedLogins('login-email', limits.loginCeiling, loginCeilingKey);
  return Object.freeze({ strict, ceiling, chain: Object.freeze([strict, ceiling] as const) });
}
