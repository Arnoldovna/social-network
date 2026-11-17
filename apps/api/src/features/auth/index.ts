// Public API of the auth feature (BUILD-ORDER "Module signatures fixed in Phase 1b"). The composition root imports only
// from here. Phase 1b stub: the signature is final, the Phase 2 auth unit fills the body and keeps every exported name
// and type.
import { Router, type RequestHandler } from 'express';

import type { Database } from '../../db/client.js';
import type { PasswordHasher } from '../../shared/auth/password.js';
import type { RealtimePublisher } from '../../shared/realtime/types.js';
import type { IssueCsrfToken } from '../../shared/security/csrf.js';
import type { LoginLimiters } from '../../shared/security/login-limiters.js';

export interface AuthModuleDeps {
  db: Database;
  hasher: PasswordHasher;
  /** Verified against for unknown emails, so both login failures take the same time (F-15). */
  timingDummyHash: string;
  requireAuth: RequestHandler;
  /** register + login per IP (`limits.auth`). */
  authLimiter: RequestHandler;
  /** Failed-login limiters (ADR-0006), mounted after `authLimiter` on the login route. */
  loginLimiters: LoginLimiters;
  /** Issues a fresh token for the regenerated session id (register, login; F-23, B-58). */
  issueCsrfToken: IssueCsrfToken;
  /** Cleared on logout (`__Host-social-network.sid` / `social-network.sid`). */
  sessionCookieName: string;
  /** Logout closes every socket of the destroyed session (F-20). */
  publisher: RealtimePublisher;
}

export interface AuthModule {
  /** Mounted at `/api/auth`; declares `/register`, `/login`, `/logout`. */
  router: Router;
}

export function createAuthModule(_deps: AuthModuleDeps): AuthModule {
  return { router: Router() };
}
