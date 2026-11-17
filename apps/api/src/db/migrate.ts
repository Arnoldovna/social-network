import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createLogger } from '../shared/logging/logger.js';
import { createDatabase, type DatabaseOptions } from './client.js';

/** apps/api/drizzle, from src/db (tsx) and from dist/db (the image copies drizzle/ next to dist/) alike. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Applies the committed SQL migrations. Used by `pnpm db:migrate`, the one-shot compose `migrate` service and the
 * integration-test global setup (template database). With the empty phase-1a journal this is a no-op.
 */
export async function runMigrations(databaseUrl: string, options: DatabaseOptions): Promise<void> {
  const handle = createDatabase(databaseUrl, options);
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
}

if (import.meta.main) {
  // Tooling entry point: reads DATABASE_URL directly and never prints it.
  const url = process.env['DATABASE_URL'];
  if (!url) {
    process.stderr.write('migrate: DATABASE_URL is required\n');
    process.exit(1);
  }
  try {
    // JSON lines whatever NODE_ENV says: a short-lived CLI must not depend on the pino-pretty worker flushing in time.
    await runMigrations(url, { logger: createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'production' }) });
    process.stdout.write('migrate: migrations applied\n');
  } catch (error) {
    process.stderr.write(`migrate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
