import { RedisStore } from 'connect-redis';
import type { Request, RequestHandler } from 'express';
import session from 'express-session';

import { appCookieName } from '../../config/app.js';
import type { RedisClient } from '../redis/redis.js';

declare module 'express-session' {
  interface SessionData {
    userId: number;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionOptions {
  redis: RedisClient;
  secret: string;
  /** true in production (HTTPS). Enables the __Host- cookie prefix. */
  secure: boolean;
  /** Redis key prefix: APP_SLUG in production, a fresh `test-<uuid>` per test app. */
  prefix: string;
  /** `SESSION_TTL_DAYS`: the rolling idle timeout of a signed-in session (F-19, ADR-0005). */
  ttlDays: number;
}

/** `__Host-social-network.sid` in production, `social-network.sid` on local http (`appCookieName`). */
export function sessionCookieName(secure: boolean): string {
  return appCookieName('sid', secure);
}

/** Redis keys of the session store: `<prefix>:sess:<session id>` (the realtime session guard reads them too). */
export function sessionKeyPrefix(prefix: string): string {
  return `${prefix}:sess:`;
}

/**
 * express-session with the connect-redis store (ADR-0005): the cookie holds only the signed, opaque session id,
 * `HttpOnly`, `SameSite=Lax`, `Secure` in production. `rolling` renews the cookie and the Redis TTL (connect-redis
 * derives it from the cookie expiry) on every response, so `ttlDays` is an idle timeout. `saveUninitialized: false`
 * stores nothing for a visitor until something is put into the session.
 */
export function createSessionMiddleware({ redis, secret, secure, prefix, ttlDays }: SessionOptions): RequestHandler {
  return session({
    store: new RedisStore({ client: redis, prefix: sessionKeyPrefix(prefix) }),
    name: sessionCookieName(secure),
    secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: ttlDays * DAY_MS,
    },
  });
}

function promisify(run: (done: (error?: unknown) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    run((error) => {
      if (error) reject(error instanceof Error ? error : new Error('Session store failure', { cause: error }));
      else resolve();
    });
  });
}

/**
 * Call on every privilege change (login, register) to prevent session fixation (F-18). `regenerate` destroys the old
 * session and starts a new one with the configured cookie, so an anonymous 2 h session (`bindAnonymousSession`)
 * becomes a normal `ttlDays` session here. The old session's CSRF token is bound to the old id: issue a new one in
 * the same response.
 */
export async function establishSession(req: Request, userId: number): Promise<void> {
  await promisify((done) => req.session.regenerate(done));
  req.session.userId = userId;
  await promisify((done) => {
    req.session.save(done);
  });
}

/** Logout (F-20): deletes the session from Redis. The caller clears the cookie (`sessionCookieName`). */
export async function destroySession(req: Request): Promise<void> {
  await promisify((done) => req.session.destroy(done));
}
