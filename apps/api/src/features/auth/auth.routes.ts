import { Router, type RequestHandler } from 'express';

import type { LoginLimiters } from '../../shared/security/login-limiters.js';
import type { AuthController } from './auth.controller.js';

export interface AuthRouteDeps {
  controller: AuthController;
  requireAuth: RequestHandler;
  /** register + login per IP, one shared budget (`limits.auth`, F-16). */
  authLimiter: RequestHandler;
  /** Failed logins per email + IP, then per email (ADR-0006). */
  loginLimiters: LoginLimiters;
}

/**
 * Mounted at `/api/auth` (API.md). CSRF protection runs app-wide before this router, so every route here needs the
 * `x-csrf-token` header (F-23). Limiters run before validation, so a body that fails it (422) is counted too.
 * Logout is `POST` only: `GET /api/auth/logout` is the 404 problem (B-18).
 */
export function createAuthRouter({ controller, requireAuth, authLimiter, loginLimiters }: AuthRouteDeps): Router {
  const router = Router();
  router.post('/register', authLimiter, controller.register);
  router.post('/login', authLimiter, ...loginLimiters.chain, controller.login);
  router.post('/logout', requireAuth, controller.logout);
  return router;
}
