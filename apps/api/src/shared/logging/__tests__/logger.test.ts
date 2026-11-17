import { DrizzleQueryError } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { errorHandler, notFoundHandler } from '../../http/problem.js';
import { createLogger, createRequestLogger } from '../logger.js';

type LogLine = Record<string, unknown> & { level: number; msg: string };

const WARN = 40;
const ERROR = 50;

/** The production logger, writing parsed JSON lines into an array. */
function capturedLogger() {
  const lines: LogLine[] = [];
  const logger = createLogger(
    { LOG_LEVEL: 'info', NODE_ENV: 'test' },
    {
      write: (line: string) => {
        lines.push(JSON.parse(line) as LogLine);
      },
    },
  );
  return { logger, lines };
}

/** A Postgres unique violation as Drizzle wraps it: the bound values are in `params`, the message and `detail`. */
function failedInsert(): DrizzleQueryError {
  const cause = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
    code: '23505',
    detail: 'Key (email)=(mira.novak@example.com) already exists.',
  });
  return new DrizzleQueryError(
    'insert into "users" ("email", "bio") values ($1, $2)',
    ['mira.novak@example.com', 'likes hiking'],
    cause,
  );
}

/** The request logger and error handler on a small app; every log line is captured as parsed JSON. */
function appWithCapturedLog() {
  const { logger, lines } = capturedLogger();
  const app = express();
  app.use(createRequestLogger(logger));
  app.get('/health/ready', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/api/users/search', (_req, res) => {
    res.json({ items: [] });
  });
  app.get('/api/boom', () => {
    throw new Error('connection to the database was lost');
  });
  app.post('/api/users', () => {
    throw failedInsert();
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return { app, lines };
}

/** pino-http writes on `finish`, which can land just after the client has the response. */
async function settled(lines: LogLine[], count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(lines).toHaveLength(count);
  });
}

describe('request logger', () => {
  it('F-113, B-50: logs the path without the query string, so search terms never reach the log', async () => {
    const { app, lines } = appWithCapturedLog();

    await request(app).get('/api/users/search?q=Mira%20Novak&limit=5');
    await settled(lines, 1);

    const [line] = lines;
    expect(line?.['req']).toMatchObject({ method: 'GET', url: '/api/users/search' });
    expect(line?.['req']).not.toHaveProperty('query');
    expect(JSON.stringify(lines)).not.toMatch(/Mira|Novak/);
  });

  it('F-113: echoes a well-formed x-request-id and logs it as the request id', async () => {
    const { app, lines } = appWithCapturedLog();

    const response = await request(app).get('/api/users/search').set('x-request-id', 'probe-12345678');
    await settled(lines, 1);

    expect(response.headers['x-request-id']).toBe('probe-12345678');
    expect(lines[0]?.['req']).toMatchObject({ id: 'probe-12345678' });
  });

  it('logs a 4xx once, at warn, with its problem type and without a stack', async () => {
    const { app, lines } = appWithCapturedLog();

    await request(app).get('/api/missing?q=Mira');
    await settled(lines, 1);

    expect(lines[0]).toMatchObject({
      level: WARN,
      problemType: 'tag:arnoldovna.github.io,2026:social-network:problem:not-found',
      res: { statusCode: 404 },
    });
    expect(lines[0]).not.toHaveProperty('err');
  });

  it('F-106: logs a 5xx once, at error, with the real error and its stack (never a synthetic one)', async () => {
    const { app, lines } = appWithCapturedLog();

    const response = await request(app).get('/api/boom');
    await settled(lines, 1);

    expect(response.status).toBe(500);
    expect(response.text).not.toContain('database');
    expect(lines[0]).toMatchObject({
      level: ERROR,
      res: { statusCode: 500 },
      err: { message: 'connection to the database was lost' },
    });
    expect(lines[0]?.['err']).toHaveProperty('stack');
    expect(JSON.stringify(lines)).not.toContain('failed with status code');
  });

  it('does not log health probes', async () => {
    const { app, lines } = appWithCapturedLog();

    await request(app).get('/health/ready');
    await request(app).get('/api/users/search');
    await settled(lines, 1);

    expect(lines[0]?.['req']).toMatchObject({ url: '/api/users/search' });
  });
});

describe('error serializer (B-50)', () => {
  it('B-50: a failed query is logged with its SQL and cause, never with the bound values', async () => {
    const { app, lines } = appWithCapturedLog();

    const response = await request(app).post('/api/users');
    await settled(lines, 1);

    expect(response.status).toBe(500);
    const err = lines[0]?.['err'] as Record<string, unknown>;
    expect(err).toMatchObject({ type: 'DrizzleQueryError' });
    expect(err['message']).toContain('insert into "users" ("email", "bio") values ($1, $2)\nparams: [redacted]');
    expect(err['message']).toContain('duplicate key value violates unique constraint "users_email_key"');
    expect(err['stack']).toContain('params: [redacted]');
    expect(JSON.stringify(lines)).not.toMatch(/mira|hiking/);
  });

  it("B-50: drops the pool's broken client (its connection parameters carry the database password)", () => {
    const { logger, lines } = capturedLogger();
    const idle = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
      client: { connectionParameters: { user: 'app', password: 'pw-in-the-client' } },
    });

    logger.error({ err: idle }, 'idle database connection failed');
    logger.error(idle);

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line['err']).toMatchObject({ code: '57P01', message: idle.message });
      expect(line['err']).not.toHaveProperty('client');
    }
    expect(JSON.stringify(lines)).not.toContain('pw-in-the-client');
  });
});
