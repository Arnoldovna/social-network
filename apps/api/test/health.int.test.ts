import { PROBLEM_TYPE_PREFIX, Problem } from '@app/shared';
import { sql } from 'drizzle-orm';
import express from 'express';
import { Client } from 'pg';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { createDatabase } from '../src/db/client.js';
import { createHealthRouter, type ReadinessChecks } from '../src/shared/http/health.js';
import { createRedisClient, reconnectDelay } from '../src/shared/redis/redis.js';
import { currentDatabaseUrl } from './database.js';
import { composeImages, serviceImage } from './images.js';
import { createTestApp, TEST_ORIGIN, type TestApp } from './test-app.js';

/**
 * Phase-1a smoke of the runnable skeleton and the per-file database harness (BUILD-ORDER 1a, ADR-0019 §4). Phase 1b
 * folds these cases into test/app.int.test.ts.
 */
describe('skeleton app on the real Postgres and Redis', () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp.close();
  });

  it('/health/live answers 200 while the process is up', async () => {
    const response = await request(testApp.app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it("/health/ready answers 200 when the file's database and Redis are reachable", async () => {
    const response = await request(testApp.app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('F-114: GET /api/health answers like /health/ready', async () => {
    const response = await request(testApp.app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('F-114: readiness answers 503 without naming the dependency when Redis is unreachable', async () => {
    await testApp.redis.close();

    for (const path of ['/health/ready', '/api/health']) {
      const response = await request(testApp.app).get(path);

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ status: 'unavailable' });
      expect(response.text).not.toMatch(/redis|database|postgres/i);
    }
  });

  it('health responses carry the request id but skip helmet (mounted before it)', async () => {
    const response = await request(testApp.app).get('/health/ready').set('x-request-id', 'probe-12345678');

    expect(response.headers['x-request-id']).toBe('probe-12345678');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['content-security-policy']).toBeUndefined();
  });

  it('F-113: a malformed x-request-id is replaced by a generated UUID', async () => {
    const response = await request(testApp.app).get('/health/live').set('x-request-id', 'bad id\twith spaces');

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('F-04, B-57, F-106, F-113: an unknown /api path answers the 404 problem+json, never HTML', async () => {
    const response = await request(testApp.app).get('/api/does-not-exist?q=Mira').set('Accept', 'text/html');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    const problem = Problem.parse(response.body);
    expect(problem).toMatchObject({
      type: `${PROBLEM_TYPE_PREFIX}not-found`,
      title: 'Not found',
      status: 404,
      instance: '/api/does-not-exist',
    });
    expect(response.text).not.toMatch(/<html|stack|at \w+ \(/i);
    expect(response.text).not.toContain('Mira');
  });

  it('F-109, B-59: API responses carry a deny-all CSP and the helmet headers, no x-powered-by', async () => {
    const response = await request(testApp.app).get('/api/does-not-exist');

    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'",
    );
  });

  it('B-07: CORS answers an allow-listed origin with credentials and ignores a foreign one', async () => {
    const allowed = await request(testApp.app)
      .options('/api/does-not-exist')
      .set('Origin', TEST_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');

    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(allowed.headers['access-control-allow-headers']).toContain('x-csrf-token');

    const foreign = await request(testApp.app)
      .options('/api/does-not-exist')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    expect(foreign.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('per-file database harness (conventions §7)', () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp.close();
  });

  it("runs on the file's own clone of the migrated template, never on the template itself", async () => {
    const name = new URL(currentDatabaseUrl()).pathname.slice(1);
    expect(name).toMatch(/^t_[0-9a-f]{32}$/);
    expect(name).not.toBe(inject('templateDatabase'));

    const result = await testApp.db.execute<{ database: string; migrations: string | null }>(
      sql`select current_database() as database, to_regclass('drizzle.__drizzle_migrations')::text as migrations`,
    );
    expect(result.rows[0]).toEqual({ database: name, migrations: 'drizzle.__drizzle_migrations' });
  });

  it('gives every test app its own Redis key prefix', async () => {
    const other = await createTestApp();
    try {
      expect(testApp.prefix).toMatch(/^test-[0-9a-f-]{36}$/);
      expect(other.prefix).not.toBe(testApp.prefix);
    } finally {
      await other.close();
    }
  });

  it('runs Testcontainers on the digest-pinned postgres and redis images from docker-compose.yml', () => {
    const images = composeImages();

    expect(images.postgres).toMatch(/^postgres:18-alpine@sha256:[a-f0-9]{64}$/);
    expect(images.redis).toMatch(/^redis:8-alpine@sha256:[a-f0-9]{64}$/);
  });

  it('fails fast when a compose image is missing or not pinned by digest', () => {
    const compose = [
      'services:',
      '  postgres:',
      '    image: postgres:18-alpine',
      '  redis:',
      '    # no image here',
      '    command: [redis-server]',
      'volumes:',
      '  redis:',
      '    image: postgres:18-alpine@sha256:' + 'a'.repeat(64),
    ].join('\n');

    expect(() => serviceImage(compose, 'postgres')).toThrow(/not pinned by digest/);
    expect(() => serviceImage(compose, 'redis')).toThrow(/has no image/);
    expect(() => serviceImage(compose, 'minio')).toThrow(/has no service "minio"/);
  });
});

describe('readiness states a live container cannot reach on its own', () => {
  let warnings: unknown[];
  const logger = {
    warn: (fields: unknown) => {
      warnings.push(fields);
    },
  };
  const appWith = (checks: ReadinessChecks, shuttingDown: boolean, checkTimeoutMs?: number) =>
    express().use(
      '/health',
      createHealthRouter({ checks, isShuttingDown: () => shuttingDown, logger, checkTimeoutMs }),
    );

  beforeEach(() => {
    warnings = [];
  });

  it('answers 503 shutting-down during graceful shutdown, before running any check', async () => {
    let checked = false;
    const app = appWith(
      {
        database: () => {
          checked = true;
          return Promise.resolve(true);
        },
      },
      true,
    );

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'shutting-down' });
    expect(checked).toBe(false);
  });

  it('keeps /health/live at 200 while shutting down (the process is still alive)', async () => {
    const response = await request(appWith({}, true)).get('/health/live');

    expect(response.status).toBe(200);
  });

  it('answers 503, never 500, when a check fails, rejects or throws synchronously', async () => {
    const apps = [
      appWith({ database: () => Promise.resolve(false), redis: () => Promise.resolve(true) }, false),
      appWith({ database: () => Promise.reject(new Error('connection refused')) }, false),
      appWith(
        {
          database: () => {
            throw new Error('pool destroyed');
          },
        },
        false,
      ),
    ];

    for (const app of apps) {
      const response = await request(app).get('/health/ready');
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ status: 'unavailable' });
    }
  });

  it('logs every failed check with its name and cause, which the 503 body never names', async () => {
    const refused = new Error('connect ECONNREFUSED');
    const app = appWith(
      {
        database: () => Promise.reject(refused),
        redis: () => Promise.resolve(false),
        storage: () => Promise.resolve(true),
      },
      false,
    );

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(warnings).toEqual([
      { check: 'database', err: refused },
      { check: 'redis', reason: 'not-ready' },
    ]);
  });

  it('answers 503 within the check timeout when a check never settles', async () => {
    const app = appWith(
      { database: () => new Promise<boolean>(() => undefined), redis: () => Promise.resolve(true) },
      false,
      50,
    );

    const started = performance.now();
    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'unavailable' });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(warnings).toEqual([{ check: 'database', reason: 'timed-out' }]);
  });
});

describe('database pool', () => {
  it('survives a terminated idle connection: logs it instead of crashing, and the next query reconnects', async () => {
    const errors: unknown[] = [];
    const database = createDatabase(currentDatabaseUrl(), {
      logger: {
        error: (fields: unknown) => {
          errors.push(fields);
        },
      },
    });
    const admin = new Client({ connectionString: inject('adminDatabaseUrl') });
    await admin.connect();
    try {
      await expect(database.ping()).resolves.toBe(true); // leaves one idle client in the pool

      // What a Postgres restart or failover does to every idle connection. Without a pool `error` listener the
      // resulting unhandled `error` event would end the process.
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [
        new URL(currentDatabaseUrl()).pathname.slice(1),
      ]);

      await vi.waitFor(() => {
        expect(errors).toHaveLength(1);
      });
      await expect(database.ping()).resolves.toBe(true);
    } finally {
      await admin.end();
      await database.close();
    }
  });

  it('ping() rejects with the driver error when the database is unreachable, so readiness can log the cause', async () => {
    const unreachable = new URL(currentDatabaseUrl());
    unreachable.port = '1'; // closed on any test machine: refused at once
    const database = createDatabase(unreachable.toString(), { logger: { error: () => undefined } });
    try {
      await expect(database.ping()).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});

describe('Redis client startup', () => {
  it('connect() rejects after a few attempts instead of hanging when Redis is unreachable', async () => {
    const errors: unknown[] = [];
    // Port 1 (tcpmux) is closed on any test machine, so every attempt is refused at once.
    const client = createRedisClient({
      url: 'redis://127.0.0.1:1',
      logger: {
        error: (error: unknown) => {
          errors.push(error);
        },
      },
    });

    await expect(client.connect()).rejects.toThrow(/no connection after 6 attempts/);
    expect(client.isOpen).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('retries forever with capped backoff once the client has been ready', () => {
    const cause = new Error('socket closed');

    expect(reconnectDelay(0, false, cause)).toBe(100);
    expect(reconnectDelay(5, false, cause)).toBeInstanceOf(Error);
    expect(reconnectDelay(5, true, cause)).toBe(3_000);
    expect(reconnectDelay(50, true, cause)).toBe(3_000);
  });
});
