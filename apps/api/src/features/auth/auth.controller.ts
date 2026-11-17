import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import type { Cookie as SessionCookie } from 'express-session';

import { validate } from '../../shared/http/validate.js';
import type { IssueCsrfToken } from '../../shared/security/csrf.js';
import { destroySession, establishSession } from '../../shared/security/session.js';
import { LoginBody, RegisterBody, type AuthResponse, type Me } from './auth.schema.js';
import type { AuthService } from './auth.service.js';

export interface AuthControllerDeps {
  service: AuthService;
  /** Must overwrite the old token: the session id changes on register and login (F-23, B-58). */
  issueCsrfToken: IssueCsrfToken;
  sessionCookieName: string;
}

export interface AuthController {
  register: RequestHandler;
  login: RequestHandler;
  logout: RequestHandler;
}

/** The attributes by which a browser matches the cookie it already holds, as express-session issued it. */
export type IssuedSessionCookie = Pick<SessionCookie, 'path' | 'domain' | 'httpOnly' | 'secure' | 'sameSite'>;

/**
 * The attributes of the `Set-Cookie` that deletes the session cookie: exactly the ones express-session issued it with,
 * read from the session itself (`req.session.cookie`) instead of being re-derived here, so they cannot drift from the
 * session configuration and the browser replaces that cookie instead of ignoring the deletion. A `__Host-` cookie in
 * particular is only replaced by a `Secure` one with `Path=/`. `secure: 'auto'` follows the request, as in
 * express-session.
 */
export function sessionCookieClearOptions(cookie: IssuedSessionCookie, requestIsSecure: boolean): CookieOptions {
  const { path, domain, httpOnly, sameSite } = cookie;
  return {
    path,
    domain,
    httpOnly,
    sameSite,
    secure: cookie.secure === 'auto' ? requestIsSecure : cookie.secure === true,
  };
}

/**
 * HTTP <-> service for `/api/auth` (ADR-0005). The session id is regenerated after every successful register and login
 * (F-18), and the response carries a CSRF token for the new id, because the old one was bound to the old id (F-23).
 */
export function createAuthController({
  service,
  issueCsrfToken,
  sessionCookieName,
}: AuthControllerDeps): AuthController {
  async function signedIn(req: Request, res: Response, user: Me, status: 200 | 201): Promise<void> {
    await establishSession(req, user.id);
    const body: AuthResponse = { user, csrfToken: issueCsrfToken(req, res) };
    res.status(status).json(body);
  }

  return {
    register: validate({ body: RegisterBody }, async ({ body }, req, res) => {
      await signedIn(req, res, await service.register(body), 201);
    }),

    login: validate({ body: LoginBody }, async ({ body }, req, res) => {
      await signedIn(req, res, await service.login(body), 200);
    }),

    // Behind `requireAuth`, and CSRF-protected like every POST (B-18). The id and the cookie attributes are read
    // before `destroy` drops the session.
    logout: async (req, res) => {
      const sessionId = req.session.id;
      const clearOptions = sessionCookieClearOptions(req.session.cookie, req.secure);
      await destroySession(req);
      service.endSession(sessionId);
      res.clearCookie(sessionCookieName, clearOptions);
      res.status(204).end();
    },
  };
}
