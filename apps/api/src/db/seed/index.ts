import type { Logger } from 'pino';

import type { Database } from '../client.js';

/**
 * Seed logic without side effects at import (DATA-MODEL.md, Seed plan; ADR-0019 §7), so `seed.int.test.ts` can run
 * it in-process against its own database. Phase-1a stub: the guard is final, `runSeed` only reports that there is
 * nothing to seed yet. The Phase 2 seed unit fills it in and adds `storage` (object storage arrives in phase 1b).
 */

/**
 * Seeding needs `SEED_ALLOW=true` set explicitly for the invocation, whatever NODE_ENV is (conventions §8): the
 * compose `seed` service runs the production image with NODE_ENV=production, so NODE_ENV can never be the switch.
 * `SEED_ALLOW` is never an .env key. The message names the variable, never a value.
 */
export function assertSeedAllowed(env: Readonly<Record<string, string | undefined>>): void {
  if (env['SEED_ALLOW'] !== 'true') {
    throw new Error('seeding is disabled: set SEED_ALLOW=true for this invocation (pnpm db:seed does)');
  }
}

export interface SeedDeps {
  db: Database;
  /** Password of every seeded account (SEED_DEMO_PASSWORD, at least 12 characters). Never logged. */
  password: string;
  logger: Pick<Logger, 'info'>;
  /** Seeded timestamps are relative to this instant, so the demo never looks stale. */
  now: () => Date;
}

/** Insert-only and idempotent (DATA-MODEL.md). The stub has no tables to fill yet and resolves without a query. */
export function runSeed({ logger }: SeedDeps): Promise<void> {
  logger.info('nothing to seed yet');
  return Promise.resolve();
}
