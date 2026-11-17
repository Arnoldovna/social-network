import { createHash } from 'node:crypto';

import { PROBLEM_TYPE_PREFIX, Problem } from '@app/shared';
import express, { type Express } from 'express';
import { pino } from 'pino';
import request, { type Response } from 'supertest';
import { describe, expect, it } from 'vitest';

import { errorHandler } from '../../http/problem.js';
import {
  createLoginLimiters,
  loginCeilingKey,
  loginEmailKey,
  loginStrictKey,
  type LoginLimiters,
} from '../login-limiters.js';
import { memoryRateLimitStores, type RateLimitStoreFactory } from '../security.js';

/**
 * The failed-login limiters of ADR-0006 (F-16, B-15) on in-memory stores, with small explicit limits: strict 2 failed
 * per email + IP, ceiling 3 failed per email. The stand-in login route answers 200 for the password `right` and 401
 * otherwise, like the auth unit's real route; each request names its client IP in X-Forwarded-For.
 */

const QUARTER_HOUR = 15 * 60_000;
const HOUR = 60 * 60_000;
const LIMITS = {
  loginStrict: { limit: 2, windowMs: QUARTER_HOUR },
  loginCeiling: { limit: 3, windowMs: HOUR },
} as const;

function loginApp(stores: RateLimitStoreFactory = memoryRateLimitStores) {
  const lines: unknown[] = [];
  const logger = pino({ level: 'warn' }, { write: (line: string) => lines.push(JSON.parse(line)) });
  const limiters = createLoginLimiters(LIMITS, stores, logger);
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.post('/api/auth/login', ...limiters.chain, (req, res) => {
    const body = req.body as { password?: unknown } | undefined;
    res.status(body?.password === 'right' ? 200 : 401).end();
  });
  app.use(errorHandler);
  return { app, limiters, lines };
}

function login(app: Express, ip: string, body: object): Promise<Response> {
  return request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send(body);
}

const attempt = (app: Express, ip: string, email: string, password = 'wrong') => login(app, ip, { email, password });

async function statuses(count: number, send: () => Promise<Response>): Promise<number[]> {
  const result: number[] = [];
  for (let index = 0; index < count; index++) result.push((await send()).status);
  return result;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('strict limiter (failed logins per email + IP)', () => {
  it('F-16, B-15: after the limit of failed logins, the next attempt is the 429 problem, even with the right password', async () => {
    const { app } = loginApp();

    expect(await statuses(2, () => attempt(app, '203.0.113.7', 'ada@example.org'))).toEqual([401, 401]);
    const limited = await attempt(app, '203.0.113.7', 'ada@example.org', 'right');

    expect(limited.status).toBe(429);
    expect(Problem.parse(limited.body)).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}rate-limited`, status: 429 });
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(QUARTER_HOUR / 1000);
    expect(limited.headers['ratelimit-policy']).toMatch(/^"login-email-ip"; q=2; w=900/);
  });

  it("ADR-0006: the owner on another network is not locked out by failures from the attacker's IP", async () => {
    const { app } = loginApp();
    await statuses(3, () => attempt(app, '203.0.113.7', 'ada@example.org'));

    expect((await attempt(app, '198.51.100.20', 'ada@example.org', 'right')).status).toBe(200);
  });

  it('F-16: successful logins do not use up the budget', async () => {
    const { app } = loginApp();

    expect(await statuses(5, () => attempt(app, '203.0.113.7', 'ada@example.org', 'right'))).toEqual(
      Array.from({ length: 5 }, () => 200),
    );
    expect(await statuses(3, () => attempt(app, '203.0.113.7', 'ada@example.org'))).toEqual([401, 401, 429]);
  });

  it('counts per account: another email from the same IP has its own budget', async () => {
    const { app } = loginApp();
    await statuses(3, () => attempt(app, '203.0.113.7', 'ada@example.org'));

    expect((await attempt(app, '203.0.113.7', 'bob@example.org')).status).toBe(401);
  });

  it('conventions §8: normalises the email like the schema (trim, lower case), so variants share one counter', async () => {
    const { app } = loginApp();
    await attempt(app, '203.0.113.7', ' Ada@Example.ORG ');
    await attempt(app, '203.0.113.7', 'ADA@EXAMPLE.ORG');

    expect((await attempt(app, '203.0.113.7', 'ada@example.org')).status).toBe(429);
  });

  it('conventions §8: IPv6 addresses in one /56 share the strict counter', async () => {
    const { app } = loginApp();
    await attempt(app, '2001:db8:aa:bb00::1', 'ada@example.org');
    await attempt(app, '2001:db8:aa:bbff::2', 'ada@example.org');

    expect((await attempt(app, '2001:db8:aa:bb42::3', 'ada@example.org')).status).toBe(429);
  });
});

describe('ceiling (failed logins per email from any source)', () => {
  it('ADR-0006: failures from several networks add up to the per-account ceiling', async () => {
    const { app } = loginApp();
    await statuses(2, () => attempt(app, '203.0.113.7', 'ada@example.org'));
    await attempt(app, '198.51.100.20', 'ada@example.org');

    const limited = await attempt(app, '192.0.2.33', 'ada@example.org', 'right');

    expect(limited.status).toBe(429);
    // Both limiters ran, so both policies are listed (draft-8); the ceiling is the one that is exhausted.
    expect(limited.headers['ratelimit-policy']).toMatch(/(^|, )"login-email"; q=3; w=3600;/);
    expect(limited.headers['ratelimit']).toMatch(/(^|, )"login-email"; r=0;/);
    // Other accounts are untouched.
    expect((await attempt(app, '192.0.2.33', 'bob@example.org', 'right')).status).toBe(200);
  });

  it('ADR-0006: attempts the strict limiter rejects never reach the ceiling, so one source cannot lock out the owner everywhere', async () => {
    const { app } = loginApp();
    // Two failures, then ten attempts the strict limiter rejects.
    expect(await statuses(12, () => attempt(app, '203.0.113.7', 'ada@example.org'))).toEqual([
      401,
      401,
      ...Array.from({ length: 10 }, () => 429),
    ]);

    // The ceiling has counted 2 of 3: the owner elsewhere still gets through.
    expect((await attempt(app, '198.51.100.20', 'ada@example.org', 'right')).status).toBe(200);
  });
});

describe('requests without an email', () => {
  it('are not counted by either limiter (validation rejects them; authLimiter still limits the IP)', async () => {
    const { app } = loginApp();
    const bodies = [{}, { email: '' }, { email: '   ' }, { email: 42 }, { password: 'right' }];

    for (const body of bodies) {
      for (let index = 0; index < 3; index++) {
        const response = await login(app, '203.0.113.7', body);
        expect(response.status).not.toBe(429);
        expect(response.headers['ratelimit']).toBeUndefined();
      }
    }
    // The real account's budget is untouched.
    expect(await statuses(3, () => attempt(app, '203.0.113.7', 'ada@example.org'))).toEqual([401, 401, 429]);
  });
});

describe('construction', () => {
  it('builds one store per limiter: login-email-ip and login-email (ADR-0006)', () => {
    const names: string[] = [];
    loginApp((name) => {
      names.push(name);
      return undefined;
    });

    expect(names).toEqual(['login-email-ip', 'login-email']);
  });

  it('chains strict before ceiling and passes express-rate-limit validation without a warning', async () => {
    const { app, limiters, lines } = loginApp();
    const { strict, ceiling, chain }: LoginLimiters = limiters;

    expect(chain).toEqual([strict, ceiling]);
    expect(Object.isFrozen(limiters)).toBe(true);
    await attempt(app, '2001:db8::1', 'ada@example.org');
    expect(lines).toEqual([]);
  });
});

describe('keys', () => {
  it('B-15: hash the normalised email, so Redis never holds the address in clear text', () => {
    const key = loginEmailKey({ body: { email: ' Ada.Lovelace@Example.org ' } });

    expect(key).toBe(sha256('ada.lovelace@example.org'));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('ada');
  });

  it('strict = email hash + client IP (/56); ceiling = email hash alone', () => {
    const hash = sha256('ada@example.org');

    expect(loginStrictKey({ ip: '203.0.113.7', body: { email: 'ada@example.org' } })).toBe(`${hash}:203.0.113.7`);
    expect(loginStrictKey({ ip: '2001:db8:aa:bb12::1', body: { email: 'ada@example.org' } })).toBe(
      `${hash}:2001:db8:aa:bb00::/56`,
    );
    expect(loginCeilingKey({ ip: '203.0.113.7', body: { email: 'ada@example.org' } })).toBe(hash);
  });

  it('read the unvalidated body defensively', () => {
    for (const body of [undefined, null, 'ada@example.org', [], { email: null }, { email: ['ada@example.org'] }]) {
      expect(loginEmailKey({ body })).toBeUndefined();
    }
  });
});
