import { setTimeout as delay } from 'node:timers/promises';

import { Router, type RequestHandler } from 'express';
import type { Logger } from 'pino';

/** Resolves true when the dependency is usable. A false, a rejection, a throw or a hang count as failed. */
export type ReadinessCheck = () => Promise<boolean>;
export type ReadinessChecks = Readonly<Record<string, ReadinessCheck>>;

export interface HealthOptions {
  checks: ReadinessChecks;
  isShuttingDown: () => boolean;
  /**
   * Receives one warning per failed check with the check's name and cause. The response body never names a
   * dependency, and probe requests are not access-logged, so this is the only trace of why readiness fails.
   */
  logger: Pick<Logger, 'warn'>;
  /**
   * A check that has not answered within this time counts as failed. Below the 3 s timeout of the compose
   * healthcheck, so the probe always gets a 503 instead of timing out itself.
   */
  checkTimeoutMs?: number;
}

const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

type CheckOutcome = { ok: true } | { ok: false; reason: 'not-ready' | 'timed-out' } | { ok: false; error: unknown };

const TIMED_OUT: CheckOutcome = { ok: false, reason: 'timed-out' };

async function runCheck(check: ReadinessCheck, timeoutMs: number): Promise<CheckOutcome> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      Promise.try(check).then(
        (ready): CheckOutcome => (ready ? { ok: true } : { ok: false, reason: 'not-ready' }),
        (error: unknown): CheckOutcome => ({ ok: false, error }),
      ),
      delay(timeoutMs, TIMED_OUT, { signal: timer.signal }),
    ]);
  } finally {
    // Promise.race already subscribed to the timer, so the AbortError it rejects with here is handled.
    timer.abort();
  }
}

/**
 * Readiness: 200 `{ status: 'ok' }` when every check passes in time, otherwise 503 `{ status: 'unavailable' }`, and
 * 503 `{ status: 'shutting-down' }` during graceful shutdown before any check runs. The body never names a
 * dependency (API.md, Infrastructure); the log does. Shared by `/health/ready` and `GET /api/health` (F-114).
 */
export function createReadinessHandler({
  checks,
  isShuttingDown,
  logger,
  checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
}: HealthOptions): RequestHandler {
  return async (_req, res) => {
    if (isShuttingDown()) {
      res.status(503).json({ status: 'shutting-down' });
      return;
    }
    const results = await Promise.all(
      Object.entries(checks).map(async ([check, run]) => {
        const outcome = await runCheck(run, checkTimeoutMs);
        if ('error' in outcome) logger.warn({ check, err: outcome.error }, 'readiness check failed');
        else if (!outcome.ok) logger.warn({ check, reason: outcome.reason }, 'readiness check failed');
        return outcome.ok;
      }),
    );
    const ok = results.every(Boolean);
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable' });
  };
}

/**
 * Mounted at `/health`, before helmet, sessions and rate limits, and not access-logged (API.md, Infrastructure).
 *
 * - `/health/live`: the process is up (container restart signal); stays 200 while shutting down.
 * - `/health/ready`: dependencies reachable (compose `--wait`, load balancer).
 */
export function createHealthRouter(options: HealthOptions): Router {
  const router = Router();
  router.get('/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  router.get('/ready', createReadinessHandler(options));
  return router;
}
