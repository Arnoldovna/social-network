/**
 * Rate limits are data, not code (OVERVIEW §10, ADR-0006). `DEFAULT_LIMITS` holds the production values;
 * `resolveLimits(env)` multiplies every `limit` by `RATE_LIMIT_MULTIPLIER` and leaves the windows unchanged. The
 * result is passed to `createApp` as `deps.limits`; tests that need exact values pass a `Limits` object directly.
 */

/** Bounds of `RATE_LIMIT_MULTIPLIER`, shared by the env schema and `resolveLimits`. */
export const RATE_LIMIT_MULTIPLIER_RANGE = { min: 1, max: 10_000 } as const;

export interface RateLimit {
  /** Requests (or socket events, or failed logins) allowed per window and key. */
  readonly limit: number;
  readonly windowMs: number;
}

export type LimiterName =
  | 'global'
  | 'auth'
  | 'loginStrict'
  | 'loginCeiling'
  | 'search'
  | 'write'
  | 'upload'
  | 'socketHandshake'
  | 'chatSend'
  | 'wallJoin';

export type Limits = Readonly<Record<LimiterName, RateLimit>>;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function freezeLimits(limits: Limits): Limits {
  for (const entry of Object.values(limits)) Object.freeze(entry);
  return Object.freeze(limits);
}

/** Production values: the table in OVERVIEW §10. The key of each limiter is decided where it is built. */
export const DEFAULT_LIMITS: Limits = freezeLimits({
  /** `u:<userId>` with a session, IP otherwise; skips `GET /api/users/:id/avatar`. */
  global: { limit: 300, windowMs: MINUTE },
  /** register + login per IP. */
  auth: { limit: 10, windowMs: 15 * MINUTE },
  /** failed logins per `sha256(email)` + IP (F-16, B-15). */
  loginStrict: { limit: 5, windowMs: 15 * MINUTE },
  /** failed logins per `sha256(email)` from any source. */
  loginCeiling: { limit: 50, windowMs: HOUR },
  /** user search per user. */
  search: { limit: 60, windowMs: MINUTE },
  /** friendship and wall writes per user. */
  write: { limit: 60, windowMs: 10 * MINUTE },
  /** avatar uploads per user. */
  upload: { limit: 20, windowMs: HOUR },
  /** socket handshakes per IP. */
  socketHandshake: { limit: 30, windowMs: MINUTE },
  /** `chat:send` per user (F-84). */
  chatSend: { limit: 10, windowMs: 10 * SECOND },
  /** `wall:join` per user. */
  wallJoin: { limit: 30, windowMs: MINUTE },
});

/**
 * Production limits × `RATE_LIMIT_MULTIPLIER` (integration tests and the E2E stack use 100, because all their traffic
 * comes from one IP). The multiplier may be fractional; each product is rounded down, which never lowers a limit
 * because the multiplier is at least 1. Throws for a multiplier outside the env range, so a hand-built call in a test
 * cannot produce `NaN` or zero limits that would disable or block a limiter.
 */
export function resolveLimits(env: { readonly RATE_LIMIT_MULTIPLIER: number }): Limits {
  const multiplier = env.RATE_LIMIT_MULTIPLIER;
  const { min, max } = RATE_LIMIT_MULTIPLIER_RANGE;
  if (!Number.isFinite(multiplier) || multiplier < min || multiplier > max) {
    throw new RangeError(`RATE_LIMIT_MULTIPLIER must be a number from ${String(min)} to ${String(max)}`);
  }
  // Same keys as DEFAULT_LIMITS, which is a complete `Limits`; fromEntries only loses the key type.
  const resolved = Object.fromEntries(
    Object.entries(DEFAULT_LIMITS).map(([name, { limit, windowMs }]) => [
      name,
      { limit: Math.floor(limit * multiplier), windowMs },
    ]),
  ) as Record<LimiterName, RateLimit>;
  return freezeLimits(resolved);
}
