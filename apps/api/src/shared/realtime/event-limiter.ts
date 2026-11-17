import type { RateLimit } from '../../config/limits.js';
import type { RedisClient } from '../redis/redis.js';
import { rateLimitKeyPrefix } from '../security/security.js';

/** The outcome of one `consume`. `retryAfterMs` is the time until the current window ends (>= 1). */
export type LimitDecision = { allowed: true; remaining: number } | { allowed: false; retryAfterMs: number };

/**
 * A fixed-window counter for socket traffic (handshakes per IP, `chat:send` and `wall:join` per user; OVERVIEW §10).
 * express-rate-limit only works on HTTP requests, so sockets use this port. `consume` rejects when the store fails;
 * callers fail closed (`internal`), as the HTTP limiters do.
 */
export interface SocketEventLimiter {
  /** Counts one event for `key` and says whether it is within the limit. */
  consume(key: string): Promise<LimitDecision>;
}

function decide(count: number, limit: number, ttlMs: number, windowMs: number): LimitDecision {
  if (count <= limit) return { allowed: true, remaining: limit - count };
  // PTTL is -1/-2 only in races the transaction rules out; fall back to the full window rather than 0.
  return { allowed: false, retryAfterMs: ttlMs > 0 ? ttlMs : windowMs };
}

export interface RedisSocketEventLimiterOptions extends RateLimit {
  redis: RedisClient;
  /** App key prefix: `APP_SLUG` in production, `test-<uuid>` per test app. */
  prefix: string;
  /** Distinct per limiter (`ws-handshake`, `chat-send`, `wall-join`); part of the Redis key. */
  name: string;
}

/**
 * Redis fixed window under `<prefix>:rl:<name>:<key>` (next to the HTTP limiters' `<prefix>:rl:<name>:` keys), so
 * limits survive restarts and hold across instances (F-84, F-91). One `MULTI` per event: `SET … NX PX` starts a
 * window only for a new key, `INCR` keeps its TTL, `PTTL` gives the time to the window's end. Atomic, so concurrent
 * events can neither skip the expiry nor double-start a window.
 */
export function createRedisSocketEventLimiter({
  redis,
  prefix,
  name,
  limit,
  windowMs,
}: RedisSocketEventLimiterOptions): SocketEventLimiter {
  const keyPrefix = rateLimitKeyPrefix(prefix, name);
  return {
    async consume(key) {
      const redisKey = keyPrefix + key;
      const [, count, ttlMs] = await redis
        .multi()
        .set(redisKey, '0', { condition: 'NX', expiration: { type: 'PX', value: windowMs } })
        .incr(redisKey)
        .pTTL(redisKey)
        .execTyped();
      return decide(count, limit, ttlMs, windowMs);
    },
  };
}

export interface MemorySocketEventLimiterOptions extends RateLimit {
  /** Injectable clock for unit tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * The same fixed window in process memory, for unit tests of socket handlers (like `memoryRateLimitStores` for the
 * HTTP limiters). Not for production: it neither survives restarts nor spans instances, and keys are never evicted
 * before their window is touched again.
 */
export function createMemorySocketEventLimiter({
  limit,
  windowMs,
  now = Date.now,
}: MemorySocketEventLimiterOptions): SocketEventLimiter {
  const windows = new Map<string, { count: number; endsAt: number }>();
  return {
    consume(key) {
      const at = now();
      let window = windows.get(key);
      if (!window || window.endsAt <= at) {
        window = { count: 0, endsAt: at + windowMs };
        windows.set(key, window);
      }
      window.count += 1;
      return Promise.resolve(decide(window.count, limit, window.endsAt - at, windowMs));
    },
  };
}
