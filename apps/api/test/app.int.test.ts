import { CsrfTokenResponse, PROBLEM_TYPE_PREFIX, Problem, ProblemFieldError, type ProblemCode } from '@app/shared';
import { sql } from 'drizzle-orm';
import express from 'express';
import { Client } from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { DEFAULT_LIMITS, type Limits } from '../src/config/limits.js';
import { createDatabase } from '../src/db/client.js';
import { createHealthRouter, type ReadinessChecks } from '../src/shared/http/health.js';
import { createRedisClient, reconnectDelay } from '../src/shared/redis/redis.js';
import { CSRF_HEADER } from '../src/shared/security/csrf.js';
import { sessionCookieName, sessionKeyPrefix } from '../src/shared/security/session.js';
import { currentDatabaseUrl } from './database.js';
import { insertUser } from './db.js';
import { csrf, signIn, type TestAgent } from './http.js';
import { composeImages, serviceImage } from './images.js';
import { createTestApp, TEST_ORIGIN, type TestApp } from './test-app.js';
import { TEST_SIGN_IN_PATH } from './test-routes.js';

/**
 * App-level contract of `createApp` on the real Postgres and Redis (BUILD-ORDER 1b, OVERVIEW §3): health probes, the
 * 404 problem for unknown paths, problem+json for every error the app itself produces, security headers, CORS, and
 * that an app built without test routes has no sign-in bypass (ADR-0019 §3). Folds in the phase-1a smoke
 * (`health.int.test.ts`): readiness states, the per-file database harness, the pool and the Redis client.
 *
 * Handshake rules (F-111, B-07 socket side, B-38) live in test/realtime.int.test.ts; helper contracts in
 * test/harness.int.test.ts.
 */

const SESSION_COOKIE = sessionCookieName(false);

/** The CSP of every API response after the health routes: the API serves no document, so it denies everything. */
const API_CSP = "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Anything that would show a stack trace, a source path or an HTML page in a response body. */
const LEAK = /<html|<!doctype|\bstack\b|at \w+ \(|node_modules|\.ts:\d+|\/src\//i;

/**
 * Asserts the RFC 9457 shape (F-106): problem+json media type, the shared `Problem` contract, the status in the body
 * equal to the HTTP status, the expected type, an `instance` without query string, and no stack or HTML in the body.
 */
function expectProblem(response: Response, status: number, code: ProblemCode | 'about:blank'): Problem {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json; charset=utf-8$/);
  const problem = Problem.parse(response.body);
  expect(problem.status).toBe(status);
  expect(problem.type).toBe(code === 'about:blank' ? code : `${PROBLEM_TYPE_PREFIX}${code}`);
  expect(problem.title.length).toBeGreaterThan(0);
  expect(problem.instance).toMatch(/^\/[^?#]*$/);
  expect(response.text).not.toMatch(LEAK);
  return problem;
}

/** The security headers helmet adds to every API response after the health routes (F-109, B-59). */
function expectSecurityHeaders(response: Response): void {
  const { headers } = response;
  expect(headers['x-powered-by']).toBeUndefined();
  expect(headers['content-security-policy']).toBe(API_CSP);
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['strict-transport-security']).toMatch(/^max-age=(\d+); includeSubDomains$/);
  const maxAge = Number(/max-age=(\d+)/.exec(String(headers['strict-transport-security']))?.[1]);
  expect(maxAge).toBeGreaterThanOrEqual(31_536_000);
}

function setCookies(response: Response): string[] {
  const header: unknown = response.headers['set-cookie'];
  return Array.isArray(header) ? header.map(String) : [];
}

/** The session id inside a Set-Cookie of the signed express-session cookie (`s:<id>.<signature>`), if one was set. */
function sessionIdOf(response: Response): string | undefined {
  const line = setCookies(response).find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  if (line === undefined) return undefined;
  const value = decodeURIComponent(line.slice(SESSION_COOKIE.length + 1).split(';')[0] ?? '');
  return /^s:(.+)\.[^.]+$/.exec(value)?.[1];
}

/** `GET /api/csrf-token` as the SPA does first: stores the token on the agent and returns the anonymous session id. */
async function anonymousSession(agent: TestAgent): Promise<string> {
  const response = await agent.get('/api/csrf-token');
  expect(response.status).toBe(200);
  agent.set(CSRF_HEADER, CsrfTokenResponse.parse(response.body).token);
  const sessionId = sessionIdOf(response);
  if (sessionId === undefined) throw new Error('GET /api/csrf-token set no session cookie');
  return sessionId;
}

/** Every session stored under the app's prefix, parsed (anonymous sessions have no `userId`). */
async function storedSessions(app: TestApp): Promise<{ userId?: number }[]> {
  const keys = await app.redis.keys(`${sessionKeyPrefix(app.prefix)}*`);
  const values = keys.length > 0 ? await app.redis.mGet(keys) : [];
  return values.flatMap((value) => (value === null ? [] : [JSON.parse(value) as { userId?: number }]));
}

// ---------------------------------------------------------------------------------------------------------------
// Health probes (F-114)
// ---------------------------------------------------------------------------------------------------------------

describe('health probes on the real Postgres and Redis', () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp.close();
  });

  it('F-114: /health/live answers 200 while the process is up', async () => {
    const response = await request(testApp.app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it("F-114: /health/ready answers 200 when the file's database and Redis are reachable", async () => {
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
    // Liveness does not depend on Redis: the process is still alive and must not be restarted for it.
    expect((await request(testApp.app).get('/health/live')).status).toBe(200);
  });

  it('F-114: readiness answers 503 when the database is unreachable', async () => {
    const admin = new Client({ connectionString: inject('adminDatabaseUrl') });
    await admin.connect();
    const name = new URL(currentDatabaseUrl()).pathname.slice(1);
    // Identifiers cannot be bound as parameters; the harness name is t_<32 hex>, so interpolating it is safe.
    expect(name).toMatch(/^t_[0-9a-f]{32}$/);
    try {
      // Refuse new connections to this file's database and end the open ones: the pool cannot reach it any more.
      await admin.query(`ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS false`);
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [name]);

      for (const path of ['/health/ready', '/api/health']) {
        const response = await request(testApp.app).get(path);

        expect(response.status).toBe(503);
        expect(response.body).toEqual({ status: 'unavailable' });
      }
    } finally {
      await admin.query(`ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS true`);
      await admin.end();
    }
    await vi.waitFor(async () => {
      expect((await request(testApp.app).get('/health/ready')).status).toBe(200);
    });
  });

  it('health responses carry the request id but skip helmet, sessions and limits (mounted before them)', async () => {
    const response = await request(testApp.app).get('/health/ready').set('x-request-id', 'probe-12345678');

    expect(response.headers['x-request-id']).toBe('probe-12345678');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.headers['ratelimit']).toBeUndefined();
    expect(setCookies(response)).toEqual([]);
  });

  it('F-113: a malformed x-request-id is replaced by a generated UUID', async () => {
    const response = await request(testApp.app).get('/health/live').set('x-request-id', 'bad id\twith spaces');

    expect(response.headers['x-request-id']).toMatch(UUID);
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

  it('aborts the signal of a timed-out check, so it can cancel its request instead of leaving it running', async () => {
    let signal: AbortSignal | undefined;
    const app = appWith(
      {
        storage: (received) => {
          signal = received;
          return new Promise<boolean>(() => undefined);
        },
      },
      false,
      50,
    );

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(signal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Unknown paths, problem+json and security headers (F-04, F-106, F-109, B-57, B-59)
// ---------------------------------------------------------------------------------------------------------------

describe('the app on the real Postgres and Redis', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  describe('unknown paths (F-04, B-57)', () => {
    it('F-04, B-57, F-106, F-113: an unknown /api path answers the 404 problem+json, never HTML', async () => {
      const response = await request(testApp.app).get('/api/does-not-exist?q=Mira').set('Accept', 'text/html');

      const problem = expectProblem(response, 404, 'not-found');
      expect(problem).toMatchObject({ title: 'Not found', instance: '/api/does-not-exist' });
      expect(response.text).not.toContain('Mira');
    });

    it('B-57: typos, the API root and browser probes such as /favicon.ico get 404, never 200 with a page', async () => {
      const paths = [
        '/api',
        '/api/',
        '/api/mee',
        '/api/auth/unknown',
        '/api/users/1/unknown',
        '/favicon.ico',
        '/index.html',
        '/',
      ];

      for (const path of paths) {
        const response = await request(testApp.app).get(path).set('Accept', 'text/html,*/*');

        expectProblem(response, 404, 'not-found');
        expect(response.headers['content-type']).not.toMatch(/text\/html/);
      }
    });

    it('F-04: the 404 problem names the whole path below a mounted router as its instance', async () => {
      const response = await request(testApp.app).get('/api/auth/unknown');

      expect(expectProblem(response, 404, 'not-found').instance).toBe('/api/auth/unknown');
    });

    it('F-04: unknown mutations with a valid CSRF token and unknown methods on known paths are 404 problems', async () => {
      const agent = request.agent(testApp.app);
      await csrf(agent);

      const responses = [
        await agent.post('/api/does-not-exist').send({ any: 'body' }),
        await agent.put('/api/does-not-exist').send({}),
        await agent.patch('/api/does-not-exist').send({}),
        await agent.delete('/api/does-not-exist'),
        await agent.delete('/api/csrf-token'),
        await agent.post('/api/health').send({}),
      ];

      for (const response of responses) expectProblem(response, 404, 'not-found');
    });

    it('F-04: HEAD on an unknown path answers 404 without a body', async () => {
      const response = await request(testApp.app).head('/api/does-not-exist');

      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      // Supertest leaves `text` undefined (despite its `string` type) when no body bytes arrived, '' otherwise.
      expect(response.text).toBeFalsy();
      expect(response.body).toEqual({});
    });
  });

  describe('problem+json for every error the app itself produces (F-106)', () => {
    it('F-106: 400 invalid-request for malformed JSON, with a fixed detail that never echoes the body', async () => {
      const agent = request.agent(testApp.app);
      await csrf(agent);

      const response = await agent
        .post('/api/does-not-exist')
        .set('Content-Type', 'application/json')
        .send('{"password": not-a-real-secret-value}');

      const problem = expectProblem(response, 400, 'invalid-request');
      expect(problem.detail).toBe('The request body is not valid JSON.');
      expect(response.text).not.toContain('not-a-real-secret-value');
    });

    it('F-106: 400 for malformed JSON is answered before CSRF protection runs, also without a token', async () => {
      const response = await request(testApp.app)
        .post('/api/does-not-exist')
        .set('Content-Type', 'application/json')
        .send('{"broken":');

      expectProblem(response, 400, 'invalid-request');
    });

    it('F-23, F-106: 403 csrf-invalid for every state-changing method without a token', async () => {
      const agent = request.agent(testApp.app);
      await csrf(agent); // a session and a token cookie exist; only the header is missing

      const responses = [
        await agent.post('/api/does-not-exist').unset(CSRF_HEADER).send({}),
        await agent.put('/api/does-not-exist').unset(CSRF_HEADER).send({}),
        await agent.patch('/api/does-not-exist').unset(CSRF_HEADER).send({}),
        await agent.delete('/api/does-not-exist').unset(CSRF_HEADER),
      ];

      for (const response of responses) {
        const problem = expectProblem(response, 403, 'csrf-invalid');
        expect(problem.detail).toBe('The CSRF token is missing or invalid. Reload and try again.');
      }
    });

    it('F-106: 413 for a JSON body over 100 kb, before CSRF and routing', async () => {
      const response = await request(testApp.app)
        .post('/api/does-not-exist')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ bio: 'x'.repeat(101 * 1024) }));

      expectProblem(response, 413, 'invalid-request');
    });

    it('F-106: 415 for a JSON body in an unsupported charset', async () => {
      const response = await request(testApp.app)
        .post('/api/does-not-exist')
        .set('Content-Type', 'application/json; charset=iso-8859-1')
        .send('{"bio":"café"}');

      expectProblem(response, 415, 'invalid-request');
    });

    it('F-106: 422 validation-failed lists each body issue in errors[] with location, path and message', async () => {
      const response = await request(testApp.app).post(TEST_SIGN_IN_PATH).send({ userId: 'one', admin: true });

      const problem = expectProblem(response, 422, 'validation-failed');
      expect(problem.instance).toBe(TEST_SIGN_IN_PATH);
      const errors = ProblemFieldError.array().min(1).parse(problem.errors);
      expect(errors.every((issue) => issue.location === 'body')).toBe(true);
      expect(errors.map((issue) => issue.path)).toContain('userId');
    });

    it('F-106, B-59: success and error responses alike carry the security headers', async () => {
      const agent = request.agent(testApp.app);
      const responses = [
        await agent.get('/api/csrf-token'),
        await agent.get('/api/does-not-exist'),
        await agent.post('/api/does-not-exist').unset(CSRF_HEADER).send({}),
        await agent.post(TEST_SIGN_IN_PATH).send({}),
      ];

      expect(responses.map((response) => response.status)).toEqual([200, 404, 403, 422]);
      for (const response of responses) expectSecurityHeaders(response);
    });
  });

  describe('security headers (F-109, B-59)', () => {
    it('F-109, B-59: API responses carry a deny-all CSP and the helmet headers, no x-powered-by', async () => {
      const response = await request(testApp.app).get('/api/does-not-exist');

      expectSecurityHeaders(response);
    });

    it('F-109: the API CSP allows no image, script, style or connection source of its own', async () => {
      const response = await request(testApp.app).get('/api/csrf-token');
      const csp = String(response.headers['content-security-policy']);

      // Everything falls back to default-src 'none'; no directive widens it again (avatars are same-origin API
      // responses rendered by the SPA, whose own CSP comes from nginx, ADR-0017).
      expect(csp.split(';').map((directive) => directive.split(' ')[0])).toEqual([
        'default-src',
        'base-uri',
        'form-action',
        'frame-ancestors',
      ]);
      expect(csp).not.toMatch(/unsafe-|https?:|\*|data:|blob:/);
    });

    it('B-59: x-powered-by is absent from every kind of response, health probes included', async () => {
      const responses = await Promise.all([
        request(testApp.app).get('/health/live'),
        request(testApp.app).get('/api/health'),
        request(testApp.app).get('/api/csrf-token'),
        request(testApp.app).get('/api/does-not-exist'),
      ]);

      for (const response of responses) expect(response.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('CORS allow-list (B-07, HTTP side)', () => {
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

    it('B-07: a simple cross-origin GET from a foreign origin never gets the origin reflected', async () => {
      const response = await request(testApp.app).get('/api/csrf-token').set('Origin', 'https://evil.example');

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });
  });
});

describe('rate limiting through the real app (F-106 429)', () => {
  let testApp: TestApp;
  const limits: Limits = { ...DEFAULT_LIMITS, global: { limit: 2, windowMs: 60_000 } };

  beforeEach(async () => {
    testApp = await createTestApp({ limits });
  });

  afterEach(async () => {
    await testApp.close();
  });

  it('F-106: the request over the global limit is the 429 rate-limited problem with Retry-After and helmet headers', async () => {
    const agent = request.agent(testApp.app);
    expect((await agent.get('/api/csrf-token')).status).toBe(200);
    expect((await agent.get('/api/does-not-exist')).status).toBe(404);

    const limited = await agent.get('/api/csrf-token');

    expectProblem(limited, 429, 'rate-limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    expectSecurityHeaders(limited);
  });

  it('F-114: health probes are never rate limited, also after the budget is spent', async () => {
    const agent = request.agent(testApp.app);
    await agent.get('/api/csrf-token');
    await agent.get('/api/csrf-token');
    expect((await agent.get('/api/csrf-token')).status).toBe(429);

    for (const path of ['/health/live', '/health/ready', '/api/health', '/api/health']) {
      expect((await agent.get(path)).status).toBe(200);
    }
  });

  it('skips avatar image reads in the real app: a spent budget still reaches routing for them', async () => {
    const agent = request.agent(testApp.app);
    await agent.get('/api/csrf-token');
    await agent.get('/api/csrf-token');

    // The avatars module is a stub in 1b, so routing answers 404; what matters is that it is not the 429.
    expect((await agent.get('/api/users/1/avatar')).status).not.toBe(429);
    expect((await agent.get('/api/does-not-exist')).status).toBe(429);
  });
});

describe('unexpected errors (F-106 500)', () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp.close();
  });

  it('F-106: a failing dependency is the generic 500 about:blank problem without stack, cause or internals', async () => {
    const user = await insertUser(testApp.db);
    const agent = request.agent(testApp.app);
    await signIn(agent, user.id);
    // The session store is Redis: with the client closed, loading the signed-in session throws inside express-session.
    await testApp.redis.close();

    const response = await agent.get('/api/csrf-token');

    const problem = expectProblem(response, 500, 'about:blank');
    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Internal server error',
      status: 500,
      detail: 'An unexpected error occurred.',
      instance: '/api/csrf-token',
    });
    expect(response.text).not.toMatch(/redis|closed|client|error:/i);
    expectSecurityHeaders(response);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// No sign-in bypass in an app built without test routes (ADR-0019 §3)
// ---------------------------------------------------------------------------------------------------------------

describe('an app built without test routes, like the composition root (ADR-0019 §3)', () => {
  let production: TestApp;
  let withTestRoutes: TestApp;

  beforeAll(async () => {
    [production, withTestRoutes] = await Promise.all([
      createTestApp({ testRoutes: false }),
      createTestApp({ testRoutes: true }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([production.close(), withTestRoutes.close()]);
  });

  it('ADR-0019 §3: answers POST /__test/sign-in with the 404 problem and signs nobody in', async () => {
    const user = await insertUser(production.db);
    const agent = request.agent(production.app);
    // With a valid token, so the request passes CSRF protection and shows that no route handles the path.
    const anonymousId = await anonymousSession(agent);

    const response = await agent.post(TEST_SIGN_IN_PATH).send({ userId: user.id });

    expect(expectProblem(response, 404, 'not-found').instance).toBe(TEST_SIGN_IN_PATH);
    expect(response.text).not.toContain('csrfToken');
    // The rolling anonymous session may renew its cookie, but its id is never regenerated (no login happened) ...
    expect([undefined, anonymousId]).toContain(sessionIdOf(response));
    // ... the agent's stored session still holds no user, and no session anywhere holds this one.
    const stored = await production.redis.get(`${sessionKeyPrefix(production.prefix)}${anonymousId}`);
    expect(stored).not.toBeNull();
    expect((JSON.parse(stored ?? '{}') as { userId?: number }).userId).toBeUndefined();
    expect((await storedSessions(production)).map((session) => session.userId)).not.toContain(user.id);
  });

  it('ADR-0019 §3: the same request signs in on an app built with test routes (the 404 is not a broken request)', async () => {
    const user = await insertUser(withTestRoutes.db);
    const agent = request.agent(withTestRoutes.app);
    const anonymousId = await anonymousSession(agent);

    const response = await agent.post(TEST_SIGN_IN_PATH).send({ userId: user.id });

    expect(response.status).toBe(200);
    const signedInId = sessionIdOf(response);
    expect(signedInId).toBeDefined();
    expect(signedInId).not.toBe(anonymousId);
    expect((await storedSessions(withTestRoutes)).map((session) => session.userId)).toContain(user.id);
  });

  it('ADR-0019 §3: without a token the path is behind CSRF protection like any other unknown mutation', async () => {
    const user = await insertUser(production.db);

    const response = await request(production.app).post(TEST_SIGN_IN_PATH).send({ userId: user.id });

    expectProblem(response, 403, 'csrf-invalid');
    expect(sessionIdOf(response)).toBeUndefined();
  });

  it('ADR-0019 §3: no other method or spelling of the path reaches a handler', async () => {
    const user = await insertUser(production.db);
    const agent = request.agent(production.app);
    const anonymousId = await anonymousSession(agent);

    const responses = [
      await agent.get(TEST_SIGN_IN_PATH),
      await agent.post(`${TEST_SIGN_IN_PATH}/`).send({ userId: user.id }),
      await agent.post(TEST_SIGN_IN_PATH.toUpperCase()).send({ userId: user.id }),
      await agent.post(`/api${TEST_SIGN_IN_PATH}`).send({ userId: user.id }),
    ];

    for (const response of responses) {
      expectProblem(response, 404, 'not-found');
      expect([undefined, anonymousId]).toContain(sessionIdOf(response));
    }
    expect((await storedSessions(production)).map((session) => session.userId)).not.toContain(user.id);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Harness and infrastructure clients (folded in from the phase-1a smoke)
// ---------------------------------------------------------------------------------------------------------------

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
