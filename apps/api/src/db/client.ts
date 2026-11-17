import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Logger } from 'pino';

import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  /** Readiness probe (`select 1`): resolves true, or rejects with the driver's error so readiness can log the cause. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  /**
   * Receives errors of idle pooled connections (a Postgres restart, a terminated backend, a network cut). pg-pool
   * emits them as `error` events on the pool; without a listener Node treats that as an unhandled `error` event and
   * the whole process crashes. The pool has already discarded the broken client, so logging is all that is left.
   */
  logger: Pick<Logger, 'error'>;
}

/**
 * One pool per process, created only by the composition root, the tooling entry points (migrate, seed) and the test
 * harness. No `casing` option: every column names its SQL name explicitly (DATA-MODEL.md, Migrations).
 */
export function createDatabase(url: string, { logger }: DatabaseOptions): DatabaseHandle {
  const pool = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    // pg waits forever for a new connection by default: an unreachable database (dropped packets) would hang every
    // query, ping() included, instead of failing.
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (error) => {
    logger.error({ err: error }, 'idle database connection failed');
  });
  const db = drizzle({ client: pool, schema });
  return {
    db,
    async ping() {
      await pool.query('select 1');
      return true;
    },
    close: () => pool.end(),
  };
}
