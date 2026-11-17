import { createHash } from 'node:crypto';

import { PROBLEM_TYPE_PREFIX, Problem } from '@app/shared';
import request, { type Response } from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { insertUser, TEST_USER_PASSWORD, type UserRow } from '../../../../test/db.js';
import { csrf, registrationBody, type TestAgent } from '../../../../test/http.js';
import { createTestApp, TEST_RATE_LIMIT_MULTIPLIER, type TestApp } from '../../../../test/test-app.js';
import { resolveLimits, type Limits, type RateLimit } from '../../../config/limits.js';
import { rateLimitKeyPrefix } from '../../../shared/security/security.js';

/**
 * The auth limiters with low, exact limits (F-16, B-15, ADR-0006). Every other test file runs with the multiplied
 * limits; each test here builds its own app (fresh Redis prefix, so fresh counters) with only the limits under test
 * lowered. `TRUST_PROXY=1` lets a test pick the client IP with `X-Forwarded-For`, as nginx sets it in production.
 */

const WINDOW_15_MIN = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const WRONG_PASSWORD = 'not the password at all';

const IP_A = '203.0.113.10';
const IP_B = '198.51.100.20';
const IP_C = '192.0.2.30';

const openApps: TestApp[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

/** A test app with the multiplied limits except the ones given (exact values). */
async function appWith(overrides: Partial<Record<'auth' | 'loginStrict' | 'loginCeiling', RateLimit>>) {
  const limits: Limits = { ...resolveLimits({ RATE_LIMIT_MULTIPLIER: TEST_RATE_LIMIT_MULTIPLIER }), ...overrides };
  const app = await createTestApp({ limits, env: { TRUST_PROXY: '1' } });
  openApps.push(app);
  return app;
}

/** An agent that always comes from `ip` (one proxy hop) and already holds a CSRF token. */
async function agentFrom(app: TestApp, ip: string): Promise<TestAgent> {
  const agent = request.agent(app.app).set('X-Forwarded-For', ip);
  await csrf(agent);
  return agent;
}

const loginAs = (agent: TestAgent, email: string, password: string) =>
  agent.post('/api/auth/login').send({ email, password });

function expectRateLimited(response: Response, limiter: string): void {
  expect(response.status, response.text).toBe(429);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(Problem.parse(response.body)).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}rate-limited`, status: 429 });
  const retryAfter = Number(response.headers['retry-after']);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThan(0);
  // draft-8 headers name the limiter that answered.
  expect(String(response.headers['ratelimit-policy'])).toContain(`"${limiter}"`);
  expect(String(response.headers['ratelimit'])).toContain(`"${limiter}"`);
}

async function failLogins(agent: TestAgent, user: UserRow, times: number): Promise<void> {
  for (let attempt = 1; attempt <= times; attempt++) {
    const response = await loginAs(agent, user.email, WRONG_PASSWORD);
    expect(response.status, `failed attempt ${String(attempt)}`).toBe(401);
  }
}

describe('auth limiter (register + login per IP)', () => {
  it('F-16, B-15: register and login share one budget per IP; the next request is 429 with Retry-After', async () => {
    const app = await appWith({ auth: { limit: 3, windowMs: WINDOW_15_MIN } });
    const user = await insertUser(app.db);
    const agent = await agentFrom(app, IP_A);

    await agent.post('/api/auth/register').send(registrationBody()).expect(201);
    await csrf(agent);
    await loginAs(agent, user.email, TEST_USER_PASSWORD).expect(200);
    await csrf(agent);
    // An invalid body still counts: the limiter runs before validation.
    await agent.post('/api/auth/register').send({}).expect(422);

    const blocked = await loginAs(agent, user.email, TEST_USER_PASSWORD);
    expectRateLimited(blocked, 'auth');
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(WINDOW_15_MIN / 1000);
    expectRateLimited(await agent.post('/api/auth/register').send(registrationBody()), 'auth');

    // Another IP has its own budget.
    const other = await agentFrom(app, IP_B);
    await other.post('/api/auth/register').send(registrationBody()).expect(201);
  });
});

describe('failed-login limiters (ADR-0006)', () => {
  it('F-16, B-15: the 6th failed login for one email from one IP is 429, even with the right password', async () => {
    const app = await appWith({ loginStrict: { limit: 5, windowMs: WINDOW_15_MIN } });
    const user = await insertUser(app.db);
    const attacker = await agentFrom(app, IP_A);

    await failLogins(attacker, user, 5);

    expectRateLimited(await loginAs(attacker, user.email, TEST_USER_PASSWORD), 'login-email-ip');
  });

  it('ADR-0006: the strict key includes the IP, so the owner on another network still logs in', async () => {
    const app = await appWith({ loginStrict: { limit: 5, windowMs: WINDOW_15_MIN } });
    const user = await insertUser(app.db);
    const otherUser = await insertUser(app.db);
    const attacker = await agentFrom(app, IP_A);
    await failLogins(attacker, user, 5);
    expectRateLimited(await loginAs(attacker, user.email, WRONG_PASSWORD), 'login-email-ip');

    const owner = await agentFrom(app, IP_B);
    await loginAs(owner, user.email, TEST_USER_PASSWORD).expect(200);
    // ... and from the blocked IP, another account is not affected either.
    await loginAs(attacker, otherUser.email, WRONG_PASSWORD).expect(401);
  });

  it('F-16: successful logins are not counted, only failed ones', async () => {
    const app = await appWith({ loginStrict: { limit: 2, windowMs: WINDOW_15_MIN } });
    const user = await insertUser(app.db);
    const agent = await agentFrom(app, IP_A);

    for (let attempt = 1; attempt <= 4; attempt++) {
      await csrf(agent);
      await loginAs(agent, user.email, TEST_USER_PASSWORD).expect(200);
    }
    await csrf(agent);
    await failLogins(agent, user, 2);

    expectRateLimited(await loginAs(agent, user.email, TEST_USER_PASSWORD), 'login-email-ip');
  });

  it('ADR-0006: the per-email ceiling stops attempts from many IPs; strict rejections never count toward it', async () => {
    const app = await appWith({
      loginStrict: { limit: 2, windowMs: WINDOW_15_MIN },
      loginCeiling: { limit: 3, windowMs: HOUR },
    });
    const user = await insertUser(app.db);
    const otherUser = await insertUser(app.db);

    const fromA = await agentFrom(app, IP_A);
    await failLogins(fromA, user, 2);
    // Rejected by the strict limiter: had it reached the ceiling, IP B's attempt below would already be blocked.
    expectRateLimited(await loginAs(fromA, user.email, WRONG_PASSWORD), 'login-email-ip');

    const fromB = await agentFrom(app, IP_B);
    await failLogins(fromB, user, 1);

    const fromC = await agentFrom(app, IP_C);
    expectRateLimited(await loginAs(fromC, user.email, TEST_USER_PASSWORD), 'login-email');
    // The ceiling is per email: other accounts are unaffected.
    await loginAs(fromC, otherUser.email, TEST_USER_PASSWORD).expect(200);
  });

  it('F-113: the limiter keys in Redis hold sha256(email), never the address', async () => {
    const app = await appWith({});
    const user = await insertUser(app.db);
    const agent = await agentFrom(app, IP_A);
    await failLogins(agent, user, 1);

    const emailHash = createHash('sha256').update(user.email).digest('hex');
    const keys = [
      ...(await app.redis.keys(`${rateLimitKeyPrefix(app.prefix, 'login-email-ip')}*`)),
      ...(await app.redis.keys(`${rateLimitKeyPrefix(app.prefix, 'login-email')}*`)),
    ];

    expect(keys.sort()).toEqual(
      [
        `${rateLimitKeyPrefix(app.prefix, 'login-email-ip')}${emailHash}:${IP_A}`,
        `${rateLimitKeyPrefix(app.prefix, 'login-email')}${emailHash}`,
      ].sort(),
    );
    expect(keys.join('\n')).not.toContain(user.email);
  });
});
