import { PROBLEM_TYPE_PREFIX, Problem } from '@app/shared';
import express, { type Express, type RequestHandler } from 'express';
import session from 'express-session';
import { pino } from 'pino';
import request, { type Response } from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { errorHandler } from '../../http/problem.js';
import {
  clientIpKey,
  createGlobalLimiter,
  globalLimitKey,
  isAvatarImageRequest,
  memoryRateLimitStores,
  rateLimiter,
  type RateLimitOptions,
  userLimitKey,
} from '../security.js';

/**
 * The limiter mechanics of security.ts on in-memory stores (OVERVIEW §10, ADR-0006, F-16): problem+json 429 with
 * `Retry-After` and draft-8 headers, keys, skip, and that express-rate-limit's own warnings reach the pino logger.
 * The Redis store is covered in session-csrf.int.test.ts.
 */

const MINUTE = 60_000;

/** A pino logger that collects its JSON lines, so a test can assert on what was logged. */
function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'warn' },
    {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { logger, lines };
}

/** `limiter` in front of a route that answers `?status=` (default 200); each request names its IP in X-Forwarded-For. */
function appWith(limiter: RequestHandler, { trustProxy = 1 }: { trustProxy?: number | false } = {}): Express {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(limiter);
  app.use((req, res) => {
    res.status(Number(req.query['status'] ?? 200)).end();
  });
  app.use(errorHandler);
  return app;
}

function probe(app: Express, ip: string, path = '/probe') {
  return request(app).get(path).set('X-Forwarded-For', ip);
}

async function statuses(count: number, send: () => PromiseLike<Response>): Promise<number[]> {
  const result: number[] = [];
  for (let index = 0; index < count; index++) result.push((await send()).status);
  return result;
}

const repeat = (count: number, status: number): number[] => Array.from({ length: count }, () => status);

function limiter(options: Partial<RateLimitOptions> = {}): RequestHandler {
  return rateLimiter({ name: 'probe', limit: 3, windowMs: MINUTE, logger: capturingLogger().logger, ...options });
}

describe('rateLimiter', () => {
  it('F-16: the request over the limit is the 429 rate-limited problem with Retry-After and draft-8 headers', async () => {
    const app = appWith(limiter());

    expect(await statuses(3, () => probe(app, '203.0.113.7'))).toEqual(repeat(3, 200));
    const limited = await probe(app, '203.0.113.7');

    expect(limited.status).toBe(429);
    expect(limited.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(Problem.parse(limited.body)).toMatchObject({
      type: `${PROBLEM_TYPE_PREFIX}rate-limited`,
      status: 429,
      instance: '/probe',
    });
    const retryAfter = Number(limited.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // pk: the partition key, a truncated hash of the client key (never the IP itself).
    expect(limited.headers['ratelimit-policy']).toMatch(/^"probe"; q=3; w=60; pk=:[A-Za-z0-9+/=]+:$/);
    expect(limited.headers['ratelimit-policy']).not.toContain('203.0.113.7');
    expect(limited.headers['ratelimit']).toMatch(/^"probe"; r=0; t=\d+$/);
    expect(limited.headers['x-ratelimit-limit']).toBeUndefined(); // no legacy headers
  });

  it('keys by client IP by default: other IPv4 clients keep their own budget', async () => {
    const app = appWith(limiter());
    await statuses(4, () => probe(app, '203.0.113.7'));

    expect((await probe(app, '203.0.113.8')).status).toBe(200);
  });

  it('conventions §8: IPv6 clients share one budget per /56 prefix', async () => {
    const app = appWith(limiter());
    expect(await statuses(3, () => probe(app, '2001:db8:aa:bb00::1'))).toEqual(repeat(3, 200));

    // Same /56, another address: still limited. Another /56: its own budget.
    expect((await probe(app, '2001:db8:aa:bbff:ffff:ffff:ffff:fffe')).status).toBe(429);
    expect((await probe(app, '2001:db8:aa:cc00::1')).status).toBe(200);
  });

  it('uses a custom keyGenerator when one is given', async () => {
    const tenantOf = (tenant: unknown): string => (typeof tenant === 'string' ? `tenant:${tenant}` : 'none');
    const app = appWith(limiter({ keyGenerator: (req) => tenantOf(req.query['tenant']) }));
    await statuses(4, () => probe(app, '203.0.113.7', '/probe?tenant=a'));

    // Same IP, other key: not limited. Other IP, same key: limited.
    expect((await probe(app, '203.0.113.7', '/probe?tenant=b')).status).toBe(200);
    expect((await probe(app, '203.0.113.9', '/probe?tenant=a')).status).toBe(429);
  });

  it('skip: skipped requests are neither counted nor limited', async () => {
    const app = appWith(limiter({ skip: (req) => req.path === '/free' }));

    expect(await statuses(10, () => probe(app, '203.0.113.7', '/free'))).toEqual(repeat(10, 200));
    const skipped = await probe(app, '203.0.113.7', '/free');
    expect(skipped.headers['ratelimit']).toBeUndefined();
    expect(await statuses(4, () => probe(app, '203.0.113.7'))).toEqual([...repeat(3, 200), 429]);
  });

  it('ADR-0006: skipSuccessfulRequests counts only failed responses', async () => {
    const app = appWith(limiter({ skipSuccessfulRequests: true }));

    expect(await statuses(5, () => probe(app, '203.0.113.7', '/probe?status=200'))).toEqual(repeat(5, 200));
    expect(await statuses(3, () => probe(app, '203.0.113.7', '/probe?status=401'))).toEqual(repeat(3, 401));
    expect((await probe(app, '203.0.113.7', '/probe?status=200')).status).toBe(429);
  });

  it("logs express-rate-limit's configuration warnings through pino with the limiter name, never the console", async () => {
    const { logger, lines } = capturingLogger();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // X-Forwarded-For while trust proxy is off: every client would share the proxy's address
    // (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR, logged at error level).
    const app = appWith(rateLimiter({ name: 'probe', limit: 3, windowMs: MINUTE, logger }), { trustProxy: false });

    await probe(app, '203.0.113.7');

    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 50,
        limiter: 'probe',
        err: expect.objectContaining({ code: 'ERR_ERL_UNEXPECTED_X_FORWARDED_FOR' }) as unknown,
      }),
    );
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('global limiter', () => {
  const limits = { global: { limit: 2, windowMs: MINUTE } };

  /** session -> sign-in (outside the limiter, to keep counts exact) -> global limiter -> routes. */
  function globalApp() {
    const { logger, lines } = capturingLogger();
    const app = express();
    app.set('trust proxy', 1);
    app.use(session({ secret: 'unit-test-session-secret-with-32-chars', resave: false, saveUninitialized: false }));
    app.post('/sign-in/:id', (req, res) => {
      req.session.userId = Number(req.params.id);
      res.status(204).end();
    });
    app.use(createGlobalLimiter(limits, memoryRateLimitStores, logger));
    app.get('/api/users/:id/avatar', (_req, res) => {
      res.status(200).end();
    });
    app.use((_req, res) => {
      res.status(200).end();
    });
    app.use(errorHandler);
    return { app, lines };
  }

  async function signedIn(app: Express, userId: number, ip: string) {
    const agent = request.agent(app);
    await agent
      .post(`/sign-in/${String(userId)}`)
      .set('X-Forwarded-For', ip)
      .expect(204);
    return { get: (path = '/api/me') => agent.get(path).set('X-Forwarded-For', ip) };
  }

  it('limits anonymous visitors per IP', async () => {
    const { app } = globalApp();

    expect(await statuses(3, () => probe(app, '203.0.113.7', '/api/csrf-token'))).toEqual([200, 200, 429]);
    expect((await probe(app, '203.0.113.8', '/api/csrf-token')).status).toBe(200);
  });

  it('limits a signed-in session per user (u:<userId>): users behind one IP do not share a budget', async () => {
    const { app } = globalApp();
    const ada = await signedIn(app, 1, '203.0.113.7');
    const bob = await signedIn(app, 2, '203.0.113.7');

    expect(await statuses(3, () => ada.get())).toEqual([200, 200, 429]);
    expect((await bob.get()).status).toBe(200);
    // The IP's anonymous budget is separate from its users' budgets.
    expect((await probe(app, '203.0.113.7')).status).toBe(200);
  });

  it("follows the user across networks: a second device of the same user shares the user's budget", async () => {
    const { app } = globalApp();
    const laptop = await signedIn(app, 1, '203.0.113.7');
    const phone = await signedIn(app, 1, '198.51.100.20');

    await statuses(2, () => laptop.get());

    expect((await phone.get()).status).toBe(429);
  });

  it('skips GET and HEAD /api/users/:id/avatar, which a page requests once per listed user', async () => {
    const { app } = globalApp();
    const viewer = await signedIn(app, 1, '203.0.113.7');

    expect(await statuses(10, () => viewer.get('/api/users/7/avatar?v=0b8e2a4c'))).toEqual(repeat(10, 200));
    const head = await request(app).head('/api/users/8/avatar').set('X-Forwarded-For', '203.0.113.9');
    expect(head.status).toBe(200);
    expect(head.headers['ratelimit']).toBeUndefined();
    // The budget is untouched.
    expect(await statuses(3, () => viewer.get())).toEqual([200, 200, 429]);
  });

  it('counts every other request, including writes to avatar-like paths', async () => {
    const { app } = globalApp();

    const results = [
      (await request(app).put('/api/users/7/avatar').set('X-Forwarded-For', '203.0.113.7')).status,
      (await probe(app, '203.0.113.7', '/api/users/7/avatars')).status,
      (await probe(app, '203.0.113.7', '/api/users/7')).status,
    ];

    expect(results).toEqual([200, 200, 429]);
  });

  it('passes express-rate-limit validation: building and using it logs no warning', async () => {
    const { app, lines } = globalApp();
    const viewer = await signedIn(app, 1, '2001:db8::1');

    await viewer.get();
    await probe(app, '2001:db8::2');

    expect(lines).toEqual([]);
  });
});

describe('key and skip functions', () => {
  it('clientIpKey: IPv4 as is, IPv4-mapped IPv6 as IPv4, IPv6 as its /56, no address as an empty key', () => {
    expect(clientIpKey({ ip: '203.0.113.7' })).toBe('203.0.113.7');
    expect(clientIpKey({ ip: '::ffff:127.0.0.1' })).toBe('127.0.0.1');
    expect(clientIpKey({ ip: '2001:db8:aa:bb12::1' })).toBe('2001:db8:aa:bb00::/56');
    expect(clientIpKey({ ip: undefined })).toBe('');
  });

  it('globalLimitKey: u:<userId> with a signed-in session, the client IP otherwise', () => {
    expect(globalLimitKey({ ip: '203.0.113.7', session: { userId: 42 } })).toBe('u:42');
    expect(globalLimitKey({ ip: '203.0.113.7', session: {} })).toBe('203.0.113.7');
    expect(globalLimitKey({ ip: '2001:db8:aa:bb12::1', session: {} })).toBe('2001:db8:aa:bb00::/56');
  });

  it('userLimitKey: u:<userId> behind requireAuth, and a wiring error (never an IP key) without a signed-in user', () => {
    expect(userLimitKey({ session: { userId: 42 } })).toBe('u:42');
    expect(() => userLimitKey({ session: {} })).toThrow(/before requireAuth/);
  });

  it('a per-user limiter mounted without requireAuth answers the generic 500 instead of limiting per IP', async () => {
    const app = express();
    app.use(session({ secret: 'unit-test-session-secret-with-32-chars', resave: false, saveUninitialized: false }));
    app.use(limiter({ keyGenerator: userLimitKey }));
    app.get('/api/users/search', (_req, res) => {
      res.json({ items: [] });
    });
    app.use(errorHandler);

    const response = await request(app).get('/api/users/search');

    expect(response.status).toBe(500);
    expect(Problem.parse(response.body).type).toBe('about:blank');
  });

  it('isAvatarImageRequest matches only reads of /api/users/<numeric id>/avatar, like Express routing', () => {
    const at = (method: string, path: string, baseUrl = '') => isAvatarImageRequest({ method, path, baseUrl });

    expect(at('GET', '/api/users/7/avatar')).toBe(true);
    expect(at('HEAD', '/api/users/7/avatar')).toBe(true);
    expect(at('GET', '/API/Users/7/Avatar/')).toBe(true);
    expect(at('GET', '/users/7/avatar', '/api')).toBe(true);

    expect(at('PUT', '/api/users/7/avatar')).toBe(false);
    expect(at('DELETE', '/api/me/avatar')).toBe(false);
    expect(at('GET', '/api/users/abc/avatar')).toBe(false);
    expect(at('GET', '/api/users/7/avatar/extra')).toBe(false);
    expect(at('GET', '/api/users/7/avatars')).toBe(false);
    expect(at('GET', '/other/api/users/7/avatar')).toBe(false);
  });

  it('memoryRateLimitStores leaves express-rate-limit on its default in-memory store', () => {
    expect(memoryRateLimitStores('global')).toBeUndefined();
  });
});
