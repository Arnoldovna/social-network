import { doubleCsrf, type DoubleCsrfUtilities } from 'csrf-csrf';
import type { Request, Response } from 'express';

import { appCookieName } from '../../config/app.js';

export interface CsrfOptions {
  secret: string;
  /** true in production (HTTPS): `Secure` cookie with the `__Host-` prefix. */
  secure: boolean;
}

/** Issues a token for the request's current session id (csrf-csrf `generateCsrfToken`). */
export type IssueCsrfToken = (req: Request, res: Response) => string;

/** The header the SPA sends the token in. The only token source: this app has no forms (ADR-0005). */
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Lifetime of an anonymous session that exists only to bind a CSRF token (2 h, ADR-0005): bots that fetch
 * `GET /api/csrf-token` cannot park week-long sessions in Redis. Login regenerates the session with the normal TTL.
 */
export const ANONYMOUS_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * App-scoped like the session cookie (`appCookieName`): `__Host-social-network.x-csrf-token` in production,
 * `social-network.x-csrf-token` on local http.
 */
export function csrfCookieName(secure: boolean): string {
  return appCookieName('x-csrf-token', secure);
}

/**
 * Signed double-submit cookie, bound to the session id (csrf-csrf 4.1, ADR-0005). GET, HEAD and OPTIONS are not
 * checked; every other method needs the token in the `x-csrf-token` header. A missing or invalid token is csrf-csrf's
 * `EBADCSRFTOKEN` 403, which the error handler maps to the `csrf-invalid` problem. `cookie-parser` must run after
 * express-session and before `doubleCsrfProtection`.
 *
 * Pitfall: with `saveUninitialized: false` an anonymous visitor gets a new session id on every request until something
 * is stored in the session. Call `bindAnonymousSession(req)` before issuing a token to a visitor so the id stays
 * stable. After login/logout the session id changes, so issue a fresh token (`overwrite: true`) in that response.
 */
export function createCsrf({ secret, secure }: CsrfOptions): DoubleCsrfUtilities {
  return doubleCsrf({
    getSecret: () => secret,
    getSessionIdentifier: (req) => req.session.id,
    cookieName: csrfCookieName(secure),
    cookieOptions: { sameSite: 'lax', path: '/', secure, httpOnly: true },
    getCsrfTokenFromRequest: (req) => req.headers[CSRF_HEADER],
  });
}

/**
 * The issuer for a response whose session id just changed (login, register, test sign-in): `overwrite: true` replaces
 * the token bound to the old id instead of reusing it (F-23, B-58).
 */
export function freshTokenIssuer(csrf: Pick<DoubleCsrfUtilities, 'generateCsrfToken'>): IssueCsrfToken {
  return (req, res) => csrf.generateCsrfToken(req, res, { overwrite: true });
}

declare module 'express-session' {
  interface SessionData {
    csrfBound: true;
  }
}

/**
 * Makes the session of a visitor persistent so its id (and the CSRF token bound to it) stays stable. An anonymous
 * session lives for 2 h; `rolling` keeps renewing it with that lifetime (express-session stores it as the cookie's
 * `originalMaxAge`). A signed-in session is left as it is, so refetching a token never shortens it.
 */
export function bindAnonymousSession(req: Request): void {
  if (req.session.userId !== undefined) return;
  req.session.csrfBound = true;
  req.session.cookie.maxAge = ANONYMOUS_SESSION_MAX_AGE_MS;
}
