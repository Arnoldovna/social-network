/**
 * Seed entry point (ADR-0019 §7, DATA-MODEL.md Seed plan): `pnpm db:seed` runs it with tsx and SEED_ALLOW=true, the
 * compose `seed` service runs `dist/db/seed/cli.js` from the API image. A tooling entry point, so it reads
 * `process.env` itself: guard first, then its own keys (key names only on failure), then the pool and the object
 * storage, `runSeed`, close both. Exit code 0 when seeded or already seeded, 1 otherwise.
 */
import { Password } from '@app/shared';

import { DatabaseUrl, LogLevel, parseEnvironment, S3EnvSchema } from '../../config/env.js';
import { createLogger } from '../../shared/logging/logger.js';
import { createS3Storage } from '../../shared/storage/object-storage.js';
import { createDatabase } from '../client.js';
import { assertSeedAllowed, runSeed } from './index.js';

/**
 * Only the keys the seed needs (least privilege: no session or CSRF secret). The S3 rules are the API's own
 * (`S3EnvSchema`), so both accept exactly the same values; `SEED_DEMO_PASSWORD` follows the registration rule (F-09).
 */
const SeedEnvSchema = S3EnvSchema.extend({
  LOG_LEVEL: LogLevel,
  DATABASE_URL: DatabaseUrl,
  SEED_DEMO_PASSWORD: Password,
});

async function main(): Promise<number> {
  assertSeedAllowed(process.env);
  const env = parseEnvironment(SeedEnvSchema, process.env);
  // JSON lines whatever NODE_ENV says: a short-lived CLI must not depend on the pino-pretty worker flushing in time.
  const logger = createLogger({ LOG_LEVEL: env.LOG_LEVEL, NODE_ENV: 'production' });
  // Storage first: building the S3 client does no I/O, and if it throws, no pool has been opened that would need closing.
  const storage = createS3Storage(env);
  const database = createDatabase(env.DATABASE_URL, { logger });
  try {
    await runSeed({ db: database.db, storage, password: env.SEED_DEMO_PASSWORD, logger, now: () => new Date() });
    return 0;
  } catch (error) {
    // Through the logger, not stderr: its error serializer drops query parameters (password hashes, emails, B-50).
    logger.error({ err: error }, 'seed failed');
    return 1;
  } finally {
    storage.client.destroy();
    await database.close();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  // Guard and environment errors name keys only, never values (parseEnvironment), so the message is safe to print.
  process.stderr.write(`seed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
