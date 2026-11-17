import express, { type Express } from 'express';
import type { Logger } from 'pino';

import type { Env } from './config/env.js';
import { createHealthRouter, createReadinessHandler, type ReadinessChecks } from './shared/http/health.js';
import { errorHandler, notFoundHandler } from './shared/http/problem.js';
import { createRequestLogger } from './shared/logging/logger.js';
import { corsAllowList, securityHeaders } from './shared/security/security.js';

/**
 * Everything the app needs from the outside world. `container.ts` builds the real one, `test/test-app.ts` one on
 * Testcontainers. Phase 1b adds the database, storage, sessions, limits, realtime and the feature modules.
 */
export interface AppDeps {
  env: Env;
  logger: Logger;
  readiness: ReadinessChecks;
  isShuttingDown: () => boolean;
}

/**
 * Phase-1a skeleton of the middleware order (express-feature-module, OVERVIEW §3): settings → request logger →
 * health → helmet → CORS → 404 → error handler. Body parsers, session, cookie-parser, the global limiter, the CSRF
 * token route, CSRF protection and the feature routers slot in between CORS and the 404 handler in phase 1b.
 */
export function createApp(deps: AppDeps): Express {
  const { env } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'simple');

  app.use(createRequestLogger(deps.logger));
  // Before helmet, sessions and limits: probes stay cheap and are never rate limited (API.md, Infrastructure).
  const health = { checks: deps.readiness, isShuttingDown: deps.isShuttingDown, logger: deps.logger };
  app.use('/health', createHealthRouter(health));
  app.get('/api/health', createReadinessHandler(health)); // F-114

  app.use(securityHeaders());
  app.use(corsAllowList(env.CORS_ORIGINS));

  // Unknown paths, /api/* included, answer the 404 problem, never an HTML page (F-04, B-57).
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
