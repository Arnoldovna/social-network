/**
 * Seed entry point (ADR-0019 §7, DATA-MODEL.md Seed plan): `pnpm db:seed` runs it with tsx and SEED_ALLOW=true, the
 * compose `seed` service runs `dist/db/seed/cli.js` from the API image. A tooling entry point, so it reads
 * `process.env` itself: guard first, then its own keys (key names only on failure), then the pool, `runSeed`, close.
 */
import { z } from 'zod';

import { DatabaseUrl, LogLevel, parseEnvironment } from '../../config/env.js';
import { createLogger } from '../../shared/logging/logger.js';
import { createDatabase } from '../client.js';
import { assertSeedAllowed, runSeed } from './index.js';

const SeedEnvSchema = z.object({
  LOG_LEVEL: LogLevel,
  DATABASE_URL: DatabaseUrl,
  SEED_DEMO_PASSWORD: z.string().min(12, 'must be at least 12 characters'),
});

async function main(): Promise<void> {
  assertSeedAllowed(process.env);
  const env = parseEnvironment(SeedEnvSchema, process.env);
  // JSON lines whatever NODE_ENV says: a short-lived CLI must not depend on the pino-pretty worker flushing in time.
  const logger = createLogger({ LOG_LEVEL: env.LOG_LEVEL, NODE_ENV: 'production' });
  const database = createDatabase(env.DATABASE_URL, { logger });
  try {
    await runSeed({ db: database.db, password: env.SEED_DEMO_PASSWORD, logger, now: () => new Date() });
  } finally {
    await database.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`seed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
