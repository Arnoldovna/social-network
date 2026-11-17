import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { Client, escapeIdentifier } from 'pg';
import type { TestProject } from 'vitest/node';

import { runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/shared/logging/logger.js';
import { databaseUrl } from './database.js';
import { composeImages } from './images.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Admin connection to the container's maintenance database; only test/setup-database.ts uses it. */
    adminDatabaseUrl: string;
    /** The migrated template every test file clones its own database from. */
    templateDatabase: string;
    redisUrl: string;
  }
}

const TEMPLATE_DATABASE = 'social_network_template';

/** Creates the template database, migrates it and ends every connection to it (CREATE … TEMPLATE needs that). */
async function prepareTemplate(adminDatabaseUrl: string): Promise<void> {
  const admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${escapeIdentifier(TEMPLATE_DATABASE)}`);
    const logger = createLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' });
    await runMigrations(databaseUrl(adminDatabaseUrl, TEMPLATE_DATABASE), { logger });
    // runMigrations has closed its pool; this ends anything that might still linger.
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [TEMPLATE_DATABASE],
    );
  } finally {
    await admin.end();
  }
}

/**
 * One Postgres and one Redis per integration run (conventions §7, ADR-0016), from the digest-pinned images in
 * docker-compose.yml. The migrations run once into `social_network_template`; test/setup-database.ts clones it for
 * every test file, so files run in parallel without sharing rows. Containers that started are stopped again when a
 * later step fails, so a broken migration never leaves them running.
 */
export default async function setup(project: TestProject) {
  const images = composeImages();
  const [postgresResult, redisResult] = await Promise.allSettled([
    new PostgreSqlContainer(images.postgres).start(),
    new RedisContainer(images.redis).start(),
  ]);
  const started = [postgresResult, redisResult].flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  const stopAll = async (): Promise<void> => {
    await Promise.allSettled(started.map((container) => container.stop()));
  };

  if (postgresResult.status === 'rejected') {
    await stopAll();
    throw postgresResult.reason;
  }
  if (redisResult.status === 'rejected') {
    await stopAll();
    throw redisResult.reason;
  }
  const postgres = postgresResult.value;
  const redis = redisResult.value;

  const adminDatabaseUrl = postgres.getConnectionUri();
  try {
    await prepareTemplate(adminDatabaseUrl);
  } catch (error) {
    await stopAll();
    throw error;
  }

  project.provide('adminDatabaseUrl', adminDatabaseUrl);
  project.provide('templateDatabase', TEMPLATE_DATABASE);
  project.provide('redisUrl', redis.getConnectionUrl());

  return stopAll;
}
