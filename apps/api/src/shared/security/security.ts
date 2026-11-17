import cors from 'cors';
import type { RequestHandler } from 'express';
import helmet from 'helmet';

const NONE = "'none'";

/**
 * Security headers for every API response after the health routes (F-109, B-59). The API never serves a document,
 * only JSON and avatar images, so its CSP denies everything instead of helmet's page-oriented defaults (which allow
 * `style-src 'unsafe-inline' https:`): a response opened directly in a browser can load nothing, submit nothing and
 * cannot be framed. The SPA's own CSP (`img-src 'self' data: blob:`, `connect-src 'self'`, no inline scripts) is set
 * by nginx (ADR-0017). The other helmet defaults stay: nosniff, same-origin CORP/COOP, HSTS, no referrer leaks.
 * Phase 1b adds the rate limiters to this file.
 */
export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: [NONE],
        baseUri: [NONE],
        formAction: [NONE],
        frameAncestors: [NONE],
      },
    },
    frameguard: { action: 'deny' },
  });
}

/**
 * Explicit allow-list (B-07): never reflect arbitrary origins while credentials (cookies) are allowed. Same-origin
 * and non-browser requests carry no Origin header and pass; a foreign origin simply gets no CORS headers, so the
 * browser blocks the response.
 */
export function corsAllowList(origins: readonly string[]): RequestHandler {
  const allowed = new Set(origins);
  return cors({
    origin: (requestOrigin, callback) => {
      callback(null, requestOrigin === undefined || allowed.has(requestOrigin));
    },
    credentials: true,
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });
}
