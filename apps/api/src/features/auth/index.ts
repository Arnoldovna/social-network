// Public API of the auth feature (BUILD-ORDER "Module signatures fixed in Phase 1b"). The composition root imports only
// from here; the signature is frozen, the body wires the feature's layers.
import type { Router, RequestHandler } from 'express';
import type { Logger } from 'pino';

import type { Database } from '../../db/client.js';
import type { PasswordHasher } from '../../shared/auth/password.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { RealtimePublisher } from '../../shared/realtime/types.js';
import type { IssueCsrfToken } from '../../shared/security/csrf.js';
import type { LoginLimiters } from '../../shared/security/login-limiters.js';
import { createAuthController } from './auth.controller.js';
import { createAuthRepository } from './auth.repository.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';

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
  /** Builds `Me.avatarUrl` in the register/login response (ADR-0010); the app's single instance. */
  avatarUrl: AvatarUrl;
  /** Logs a failed password-hash upgrade after a successful login (ADR-0006). */
  logger: Logger;
}

export interface AuthModule {
  /** Mounted at `/api/auth`; declares `/register`, `/login`, `/logout`. */
  router: Router;
}

/** Construction only: no I/O and nothing that can throw at import or creation time (BUILD-ORDER rule 7). */
export function createAuthModule(deps: AuthModuleDeps): AuthModule {
  const service = createAuthService({
    accounts: createAuthRepository(deps.db),
    hasher: deps.hasher,
    timingDummyHash: deps.timingDummyHash,
    avatarUrl: deps.avatarUrl,
    publisher: deps.publisher,
    logger: deps.logger,
  });
  const controller = createAuthController({
    service,
    issueCsrfToken: deps.issueCsrfToken,
    sessionCookieName: deps.sessionCookieName,
  });
  return {
    router: createAuthRouter({
      controller,
      requireAuth: deps.requireAuth,
      authLimiter: deps.authLimiter,
      loginLimiters: deps.loginLimiters,
    }),
  };
}
