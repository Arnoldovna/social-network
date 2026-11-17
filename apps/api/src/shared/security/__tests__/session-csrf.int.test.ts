import { randomBytes, randomUUID } from 'node:crypto';

import { PROBLEM_TYPE_PREFIX, Problem } from '@app/shared';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { pino } from 'pino';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { actorOf, requireAuth } from '../../auth/guards.js';
import { errorHandler } from '../../http/problem.js';
import { createRedisClient, type RedisClient } from '../../redis/redis.js';
import { ANONYMOUS_SESSION_MAX_AGE_MS, bindAnonymousSession, createCsrf, csrfCookieName } from '../csrf.js';
import { createGlobalLimiter, rateLimiter, redisRateLimitStores } from '../security.js';
import {
  createSessionMiddleware,
  destroySession,
  establishSession,
  sessionCookieName,
  sessionKeyPrefix,
} from '../session.js';

/**
 * Sessions, CSRF and the Redis limiter store on the run's real Redis 8 (ADR-0005, ADR-0006, F-18–F-20, F-23, B-02,
 * B-17, B-18, B-58). The app below wires the shared pieces in the order app.ts uses (session -> cookie-parser ->
 * token endpoint -> CSRF protection -> routes -> error handler); its login and logout routes do what the auth unit's
 * controller does with them. Every app gets its own `test-<uuid>` key prefix.
 */

// Fresh random secrets per run: nothing secret-shaped is committed (gitleaks) and no test can depend on a value.
const SESSION_SECRET = randomBytes(32).toString('base64url');
const CSRF_SECRET = randomBytes(32).toString('base64url');
const TTL_DAYS = 3;
const TTL_S = TTL_DAYS * 24 * 60 * 60;
const ANONYMOUS_TTL_S = ANONYMOUS_SESSION_MAX_AGE_MS / 1000;
const silent = pino({ level: 'silent' });

let redis: RedisClient;

beforeAll(async () => {
  redis = createRedisClient({ url: inject('redisUrl'), logger: silent });
  await redis.connect();
});

afterAll(async () => {
  await redis.close();
});

/** `globalLimiter` mounts the Redis-backed global limiter where app.ts does: after cookie-parser, before the token. */
function sessionApp({ secure = false, globalLimiter = false }: { secure?: boolean; globalLimiter?: boolean } = {}): {
  app: Express;
  prefix: string;
} {
  const prefix = `test-${randomUUID()}`;
  const csrf = createCsrf({ secret: CSRF_SECRET, secure });
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(createSessionMiddleware({ redis, secret: SESSION_SECRET, secure, prefix, ttlDays: TTL_DAYS }));
  app.use(cookieParser());
  if (globalLimiter) {
    const limits = { global: { limit: 300, windowMs: 60_000 } };
    app.use(createGlobalLimiter(limits, redisRateLimitStores(redis, prefix), silent));
  }
  app.get('/api/csrf-token', (req, res) => {
    bindAnonymousSession(req);
    res.json({ token: csrf.generateCsrfToken(req, res) });
  });
  app.use(csrf.doubleCsrfProtection);
  app.post('/api/auth/login', async (req, res) => {
    const { userId } = req.body as { userId: number };
    await establishSession(req, userId);
    res.json({ csrfToken: csrf.generateCsrfToken(req, res, { overwrite: true }) });
  });
  app.post('/api/auth/logout', requireAuth, async (req, res) => {
    await destroySession(req);
    res.clearCookie(sessionCookieName(secure), { path: '/' });
    res.status(204).end();
  });
  app.get('/api/me', requireAuth, (req, res) => {
    res.json(actorOf(req));
  });
  app.post('/api/me/echo', requireAuth, (req, res) => {
    res.json(actorOf(req));
  });
  app.get('/api/ping', (_req, res) => {
    res.status(204).end();
  });
  app.use(errorHandler);
  return { app, prefix };
}

function setCookies(response: Response): string[] {
  const header: unknown = response.headers['set-cookie'];
  return Array.isArray(header) ? header.map(String) : [];
}

function cookieLine(response: Response, name: string): string | undefined {
  return setCookies(response).find((line) => line.startsWith(`${name}=`));
}

/** The session id inside a signed express-session cookie (`s:<id>.<signature>`, URL-encoded). */
function sessionIdOf(response: Response, name = sessionCookieName(false)): string {
  const line = cookieLine(response, name);
  const value = decodeURIComponent(line?.slice(name.length + 1).split(';')[0] ?? '');
  const match = /^s:(.+)\.[^.]+$/.exec(value);
  if (match?.[1] === undefined) throw new Error(`no ${name} cookie in the response`);
  return match[1];
}

/** Seconds until the cookie's `Expires` attribute. */
function expiresInSeconds(line: string | undefined): number {
  const expires = /Expires=([^;]+)/i.exec(line ?? '')?.[1];
  if (expires === undefined) throw new Error('cookie without Expires');
  return (Date.parse(expires) - Date.now()) / 1000;
}

async function storedSession(prefix: string, sessionId: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(`${sessionKeyPrefix(prefix)}${sessionId}`);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

const ttlOf = (prefix: string, sessionId: string) => redis.ttl(`${sessionKeyPrefix(prefix)}${sessionId}`);

type Agent = ReturnType<typeof request.agent>;

/** GET /api/csrf-token: the token and the anonymous session id it is bound to. */
async function anonymousToken(agent: Agent): Promise<{ token: string; sessionId: string; response: Response }> {
  const response = await agent.get('/api/csrf-token').expect(200);
  return { token: (response.body as { token: string }).token, sessionId: sessionIdOf(response), response };
}

/** The real login flow: token for the anonymous session, then login with it. */
async function signIn(agent: Agent, userId: number) {
  const anonymous = await anonymousToken(agent);
  const response = await agent
    .post('/api/auth/login')
    .set('x-csrf-token', anonymous.token)
    .send({ userId })
    .expect(200);
  return {
    anonymous,
    csrfToken: (response.body as { csrfToken: string }).csrfToken,
    sessionId: sessionIdOf(response),
    response,
  };
}

function expectCsrfProblem(response: Response): void {
  expect(response.status).toBe(403);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(Problem.parse(response.body)).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}csrf-invalid`, status: 403 });
}

describe('session middleware', () => {
  it('F-19: stores nothing and sets no cookie for a visitor who never puts anything into the session', async () => {
    const { app, prefix } = sessionApp();

    const response = await request(app).get('/api/ping').expect(204);

    expect(setCookies(response)).toEqual([]);
    expect(await redis.keys(`${prefix}:*`)).toEqual([]);
  });

  it('F-19, B-17: the cookie on local http is social-network.sid, HttpOnly, SameSite=Lax, Path=/, not Secure', async () => {
    const { app } = sessionApp();

    const { response } = await anonymousToken(request.agent(app));
    const line = cookieLine(response, 'social-network.sid');

    expect(line).toMatch(/; Path=\/(;|$)/);
    expect(line).toMatch(/; HttpOnly(;|$)/);
    expect(line).toMatch(/; SameSite=Lax(;|$)/);
    expect(line).not.toMatch(/; Secure/i);
    expect(line).not.toMatch(/; Domain=/i);
  });

  it('conventions §8: in production the cookies are __Host-social-network.sid and __Host-social-network.x-csrf-token, Secure', async () => {
    const { app } = sessionApp({ secure: true });

    const response = await request(app).get('/api/csrf-token').set('X-Forwarded-Proto', 'https').expect(200);

    for (const name of ['__Host-social-network.sid', '__Host-social-network.x-csrf-token']) {
      const line = cookieLine(response, name);
      expect(line, name).toMatch(/; Secure(;|$)/);
      expect(line, name).toMatch(/; Path=\/(;|$)/);
      expect(line, name).toMatch(/; HttpOnly(;|$)/);
      expect(line, name).not.toMatch(/; Domain=/i); // __Host- forbids a Domain attribute
    }
    expect(sessionCookieName(true)).toBe('__Host-social-network.sid');
    expect(csrfCookieName(true)).toBe('__Host-social-network.x-csrf-token');
  });

  it('B-02: the cookie holds only a signed, opaque id; a tampered signature is an anonymous request, not a 500', async () => {
    const { app } = sessionApp();
    const agent = request.agent(app);
    const { response } = await signIn(agent, 42);
    const value = cookieLine(response, 'social-network.sid')?.split(';')[0] ?? '';

    expect(value).not.toContain('42');
    const tampered = `${value.slice(0, -2)}xx`;
    const me = await request(app).get('/api/me').set('Cookie', tampered);
    expect(me.status).toBe(401);
  });
});

describe('anonymous CSRF session (bindAnonymousSession)', () => {
  it('ADR-0005: GET /api/csrf-token stores a 2 h session that holds no user', async () => {
    const { app, prefix } = sessionApp();

    const { sessionId, response } = await anonymousToken(request.agent(app));

    const expiresIn = expiresInSeconds(cookieLine(response, 'social-network.sid'));
    expect(expiresIn).toBeGreaterThan(ANONYMOUS_TTL_S - 60);
    expect(expiresIn).toBeLessThanOrEqual(ANONYMOUS_TTL_S);
    const ttl = await ttlOf(prefix, sessionId);
    expect(ttl).toBeGreaterThan(ANONYMOUS_TTL_S - 60);
    expect(ttl).toBeLessThanOrEqual(ANONYMOUS_TTL_S);
    const stored = await storedSession(prefix, sessionId);
    expect(Object.keys(stored ?? {}).sort()).toEqual(['cookie', 'csrfBound']);
  });

  it('ADR-0005: the id stays stable and rolling renews the 2 h lifetime, never the 7-day one', async () => {
    const { app, prefix } = sessionApp();
    const agent = request.agent(app);
    const first = await anonymousToken(agent);

    const again = await anonymousToken(agent);
    await agent.get('/api/ping').expect(204);

    expect(again.sessionId).toBe(first.sessionId);
    expect(again.token).toBe(first.token); // the bound token is reused, not rotated
    expect(await ttlOf(prefix, first.sessionId)).toBeLessThanOrEqual(ANONYMOUS_TTL_S);
  });
});

describe('CSRF protection (F-23, B-58)', () => {
  it('F-23: a state-changing request without a token is the 403 csrf-invalid problem', async () => {
    const { app } = sessionApp();
    const agent = request.agent(app);
    await anonymousToken(agent);

    expectCsrfProblem(await agent.post('/api/auth/login').send({ userId: 1 }));
    expectCsrfProblem(await request(app).post('/api/auth/login').send({ userId: 1 }));
  });

  it('F-23: rejects a made-up token and a token sent without its cookie', async () => {
    const { app } = sessionApp();
    const agent = request.agent(app);
    const { token } = await anonymousToken(agent);

    expectCsrfProblem(
      await agent
        .post('/api/auth/login')
        .set('x-csrf-token', `${token.slice(0, -4)}AAAA`)
        .send({}),
    );
    expectCsrfProblem(await request(app).post('/api/auth/login').set('x-csrf-token', token).send({ userId: 1 }));
  });

  it("ADR-0005: a token is bound to its session: another visitor's token is rejected", async () => {
    const { app } = sessionApp();
    const victim = request.agent(app);
    const attacker = request.agent(app);
    const stolen = await anonymousToken(victim);
    await anonymousToken(attacker);

    expectCsrfProblem(await attacker.post('/api/auth/login').set('x-csrf-token', stolen.token).send({ userId: 1 }));
  });

  it('F-23: GET requests need no token; PUT, PATCH and DELETE do', async () => {
    const { app } = sessionApp();
    const agent = request.agent(app);
    await signIn(agent, 42);

    await agent.get('/api/me').expect(200);
    for (const method of ['put', 'patch', 'delete'] as const) {
      expectCsrfProblem(await agent[method]('/api/me/echo'));
    }
  });

  it('F-23: only the x-csrf-token header counts: a token in the body or query is ignored', async () => {
    const { app } = sessionApp();
    const agent = request.agent(app);
    const { csrfToken } = await signIn(agent, 42);

    expectCsrfProblem(await agent.post('/api/me/echo').send({ _csrf: csrfToken }));
    expectCsrfProblem(await agent.post(`/api/me/echo?_csrf=${encodeURIComponent(csrfToken)}`));
  });
});

describe('login (establishSession, F-18)', () => {
  it('F-18: regenerates the session id, deletes the anonymous session and stores only the user id', async () => {
    const { app, prefix } = sessionApp();
    const { anonymous, sessionId } = await signIn(request.agent(app), 42);

    expect(sessionId).not.toBe(anonymous.sessionId);
    expect(await storedSession(prefix, anonymous.sessionId)).toBeNull();
    const stored = await storedSession(prefix, sessionId);
    expect(stored).toMatchObject({ userId: 42 });
    expect(Object.keys(stored ?? {}).sort()).toEqual(['cookie', 'userId']);
  });

  it('F-19: the signed-in session gets the configured idle TTL (SESSION_TTL_DAYS), not the anonymous 2 h', async () => {
    const { app, prefix } = sessionApp();
    const { sessionId, response } = await signIn(request.agent(app), 42);

    const ttl = await ttlOf(prefix, sessionId);
    expect(ttl).toBeGreaterThan(TTL_S - 60);
    expect(ttl).toBeLessThanOrEqual(TTL_S);
    expect(expiresInSeconds(cookieLine(response, 'social-network.sid'))).toBeGreaterThan(TTL_S - 60);
  });

  it('F-23: the token issued before login is dead afterwards; the token from the login response works', async () => {
    const { app } = sessionApp();
    const agent = request.agent(app);
    const { anonymous, csrfToken } = await signIn(agent, 42);

    expect(csrfToken).not.toBe(anonymous.token);
    expectCsrfProblem(await agent.post('/api/me/echo').set('x-csrf-token', anonymous.token));
    const echo = await agent.post('/api/me/echo').set('x-csrf-token', csrfToken).expect(200);
    expect(echo.body).toEqual({ userId: 42 });
  });

  it('ADR-0005: refetching a token while signed in neither shortens the session nor breaks the old token', async () => {
    const { app, prefix } = sessionApp();
    const agent = request.agent(app);
    const { sessionId, csrfToken } = await signIn(agent, 42);

    const refetched = await anonymousToken(agent);

    expect(refetched.sessionId).toBe(sessionId);
    expect(await ttlOf(prefix, sessionId)).toBeGreaterThan(TTL_S - 60);
    expect(await storedSession(prefix, sessionId)).not.toHaveProperty('csrfBound');
    await agent.post('/api/me/echo').set('x-csrf-token', refetched.token).expect(200);
    await agent.post('/api/me/echo').set('x-csrf-token', csrfToken).expect(200);
  });
});

describe('logout (destroySession, F-20, B-18)', () => {
  it('F-20: destroys the session in Redis and clears the cookie; the old cookie is unauthenticated afterwards', async () => {
    const { app, prefix } = sessionApp();
    const agent = request.agent(app);
    const { csrfToken, sessionId, response } = await signIn(agent, 42);
    const oldCookie = cookieLine(response, 'social-network.sid')?.split(';')[0] ?? '';

    const logout = await agent.post('/api/auth/logout').set('x-csrf-token', csrfToken).expect(204);

    expect(cookieLine(logout, 'social-network.sid')).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(await storedSession(prefix, sessionId)).toBeNull();
    await agent.get('/api/me').expect(401);
    await request(app).get('/api/me').set('Cookie', oldCookie).expect(401);
  });

  it('B-18: logout without a CSRF token is rejected and keeps the session', async () => {
    const { app, prefix } = sessionApp();
    const agent = request.agent(app);
    const { sessionId } = await signIn(agent, 42);

    expectCsrfProblem(await agent.post('/api/auth/logout'));
    expect(await storedSession(prefix, sessionId)).toMatchObject({ userId: 42 });
  });
});

describe('Redis rate-limit stores', () => {
  it('ADR-0006: counters live under <prefix>:rl:<name>: and hold across app instances (restart, second instance)', async () => {
    const prefix = `test-${randomUUID()}`;
    const build = () => {
      const app = express();
      app.use(
        rateLimiter({
          name: 'auth',
          limit: 2,
          windowMs: 60_000,
          store: redisRateLimitStores(redis, prefix)('auth'),
          logger: silent,
        }),
      );
      app.use((_req, res) => {
        res.status(204).end();
      });
      app.use(errorHandler);
      return app;
    };
    const first = build();
    const second = build();

    await request(first).get('/').expect(204);
    await request(second).get('/').expect(204);
    const limited = await request(first).get('/');

    expect(limited.status).toBe(429);
    const keys = await redis.keys(`${prefix}:*`);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^${prefix}:rl:auth:`));
    expect(await redis.ttl(keys[0] ?? '')).toBeLessThanOrEqual(60);
  });

  it('the global limiter keys a visitor by IP and a signed-in session as u:<userId> in Redis', async () => {
    const { app, prefix } = sessionApp({ globalLimiter: true });
    const agent = request.agent(app);
    await signIn(agent, 42); // anonymous: token + login, from 127.0.0.1

    await agent.get('/api/me').expect(200);

    expect((await redis.keys(`${prefix}:rl:global:*`)).sort()).toEqual([
      `${prefix}:rl:global:127.0.0.1`,
      `${prefix}:rl:global:u:42`,
    ]);
  });
});
