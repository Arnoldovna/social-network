import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { AuthResponse, CsrfTokenResponse, PROBLEM_TYPE_PREFIX, Problem, type ProblemCode } from '@app/shared';
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { insertUser, TEST_USER_PASSWORD, uniqueEmail } from '../../../../test/db.js';
import { csrf, login, register, registrationBody, type TestAgent } from '../../../../test/http.js';
import { connectAs, waitForDisconnect, type TestSocket } from '../../../../test/socket.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { users } from '../../../db/schema/index.js';
import { argon2Hasher } from '../../../shared/auth/password.js';
import { rooms } from '../../../shared/realtime/rooms.js';
import { CSRF_HEADER, csrfCookieName } from '../../../shared/security/csrf.js';
import { sessionCookieName, sessionKeyPrefix } from '../../../shared/security/session.js';

/**
 * `/api/auth/*` through the real app (API.md "Auth", ADR-0005, ADR-0006): real Postgres (this file's own database),
 * sessions in the run's Redis under this app's prefix, the real argon2id hasher and the real CSRF protection. This is
 * the only feature whose tests sign in through the real `register()`/`login()` (BUILD-ORDER rule 7). Rate limits run
 * with the test multiplier here; the production-shaped limits are proven in `auth-limits.int.test.ts`.
 */

const SESSION_COOKIE = sessionCookieName(false);
const CSRF_COOKIE = csrfCookieName(false);
const DAY_S = 24 * 60 * 60;
/** argon2id with the pinned parameters of `shared/auth/password.ts` (ADR-0006, B-16). */
const PINNED_ARGON2ID = /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/;

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

const openSockets: TestSocket[] = [];

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.close();
});

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

const newAgent = (app: TestApp = testApp): TestAgent => request.agent(app.app);

function setCookies(response: Response): string[] {
  const header: unknown = response.headers['set-cookie'];
  return Array.isArray(header) ? header.map(String) : [];
}

function cookieLine(response: Response, name: string): string | undefined {
  return setCookies(response).find((line) => line.startsWith(`${name}=`));
}

/** `name=value` of a cookie the response set, as a browser would send it back. */
function cookiePair(response: Response, name: string): string {
  const pair = cookieLine(response, name)?.split(';')[0];
  if (pair === undefined) throw new Error(`no ${name} cookie in the response`);
  return pair;
}

/** The session id inside the signed express-session cookie (`s:<id>.<signature>`, URL-encoded). */
function sessionIdOf(response: Response): string {
  const value = decodeURIComponent(cookiePair(response, SESSION_COOKIE).slice(SESSION_COOKIE.length + 1));
  const match = /^s:(.+)\.[^.]+$/.exec(value);
  if (match?.[1] === undefined) throw new Error('the session cookie is not a signed express-session id');
  return match[1];
}

/** Seconds until the cookie's `Expires` attribute. */
function expiresInSeconds(line: string | undefined): number {
  const expires = /Expires=([^;]+)/i.exec(line ?? '')?.[1];
  if (expires === undefined) throw new Error('cookie without Expires');
  return (Date.parse(expires) - Date.now()) / 1000;
}

const sessionKey = (app: TestApp, sessionId: string): string => `${sessionKeyPrefix(app.prefix)}${sessionId}`;

async function storedSession(sessionId: string, app: TestApp = testApp): Promise<Record<string, unknown> | null> {
  const raw = await app.redis.get(sessionKey(app, sessionId));
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

/** `GET /api/csrf-token` for a visitor: the token (stored on the agent) and the anonymous session id it is bound to. */
async function anonymousToken(agent: TestAgent): Promise<{ token: string; sessionId: string }> {
  const response = await agent.get('/api/csrf-token').expect(200);
  const { token } = CsrfTokenResponse.parse(response.body);
  agent.set(CSRF_HEADER, token);
  return { token, sessionId: sessionIdOf(response) };
}

/** Asserts a problem+json response with this status and code, and returns the parsed problem. */
function expectProblem(response: Response, status: number, code: ProblemCode): Problem {
  expect(response.status, response.text).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  const problem = Problem.parse(response.body);
  expect(problem.type).toBe(`${PROBLEM_TYPE_PREFIX}${code}`);
  return problem;
}

async function storedUser(id: number) {
  const [row] = await testApp.db.select().from(users).where(eq(users.id, id));
  if (!row) throw new Error(`user ${String(id)} not found`);
  return row;
}

function track(socket: TestSocket): TestSocket {
  openSockets.push(socket);
  return socket;
}

// ---------------------------------------------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------------------------------------------

describe('POST /api/auth/register', () => {
  it('F-06, F-18, F-19, B-17: creates the account and signs it in with a regenerated 7-day session', async () => {
    const agent = newAgent();
    const anonymous = await anonymousToken(agent);
    const body = registrationBody({ firstName: 'Ada', lastName: 'Lovelace' });

    const response = await agent.post('/api/auth/register').send(body).expect(201);

    const { user, csrfToken } = AuthResponse.parse(response.body);
    expect(user).toEqual({ id: user.id, firstName: 'Ada', lastName: 'Lovelace', bio: null, avatarUrl: null });
    expect(csrfToken).not.toBe(anonymous.token);

    // F-18: a new id; the anonymous session is gone, the new one holds the user.
    const sessionId = sessionIdOf(response);
    expect(sessionId).not.toBe(anonymous.sessionId);
    expect(await storedSession(anonymous.sessionId)).toBeNull();
    expect(await storedSession(sessionId)).toMatchObject({ userId: user.id });

    // F-19, B-17: HttpOnly, SameSite=Lax, Path=/, not Secure on local http; 7 days instead of the anonymous 2 h.
    const line = cookieLine(response, SESSION_COOKIE);
    expect(line).toMatch(/; Path=\/(;|$)/);
    expect(line).toMatch(/; HttpOnly(;|$)/);
    expect(line).toMatch(/; SameSite=Lax(;|$)/);
    expect(line).not.toMatch(/; Secure/i);
    expect(expiresInSeconds(line)).toBeGreaterThan(7 * DAY_S - 60);
    expect(expiresInSeconds(line)).toBeLessThanOrEqual(7 * DAY_S);
    expect(await testApp.redis.ttl(sessionKey(testApp, sessionId))).toBeGreaterThan(7 * DAY_S - 60);

    // Signed in, and the returned token is the one that works for the new session.
    await agent.post('/api/auth/logout').set(CSRF_HEADER, csrfToken).expect(204);
  });

  it('F-23, B-58: the token from before registration is bound to the old session id and rejected afterwards', async () => {
    const agent = newAgent();
    const anonymous = await anonymousToken(agent);
    const response = await agent.post('/api/auth/register').send(registrationBody()).expect(201);
    const { csrfToken } = AuthResponse.parse(response.body);

    expect(cookieLine(response, CSRF_COOKIE)).toBeDefined();
    expectProblem(await agent.post('/api/auth/logout').set(CSRF_HEADER, anonymous.token), 403, 'csrf-invalid');
    await agent.post('/api/auth/logout').set(CSRF_HEADER, csrfToken).expect(204);
  });

  it('F-17, B-16, B-19, B-02: stores a pinned argon2id hash; neither response nor cookie carries email, hash or id', async () => {
    const agent = newAgent();
    const { user, email, password, response } = await register(agent);
    const row = await storedUser(user.id);

    expect(row.passwordHash).toMatch(PINNED_ARGON2ID);
    expect(row.passwordHash).not.toContain(password);
    expect(await argon2Hasher.verify(row.passwordHash, password)).toBe(true);

    expect(response.text).not.toContain(email);
    expect(response.text).not.toContain('$argon2');
    expect(response.text).not.toContain(password);
    const cookie = decodeURIComponent(cookiePair(response, SESSION_COOKIE));
    expect(cookie).not.toContain(email);
    expect(cookie).not.toContain(`"userId"`);
  });

  it('F-07: first and last name are trimmed and may have 1 to 100 characters', async () => {
    const trimmed = await register(newAgent(), { firstName: '  Ada  ', lastName: '\tLovelace\n' });
    expect(trimmed.user).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(await storedUser(trimmed.user.id)).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace' });

    const longest = await register(newAgent(), { firstName: 'a'.repeat(100), lastName: 'b'.repeat(100) });
    expect(longest.user.firstName).toHaveLength(100);

    const agent = newAgent();
    await csrf(agent);
    const invalid = await agent
      .post('/api/auth/register')
      .send(registrationBody({ firstName: '   ', lastName: 'c'.repeat(101) }));
    const problem = expectProblem(invalid, 422, 'validation-failed');
    expect(problem.errors).toEqual(
      expect.arrayContaining([
        { location: 'body', path: 'firstName', message: 'Please enter your first name.' },
        expect.objectContaining({ location: 'body', path: 'lastName' }),
      ]),
    );
    expect(problem.errors).toHaveLength(2);
  });

  it('F-08, B-10: the email is trimmed and stored lower-cased; + addressing and long TLDs are valid', async () => {
    const local = randomUUID();
    const { user } = await register(newAgent(), { email: `  ${local}+Tag@Example.Photography ` });

    expect((await storedUser(user.id)).email).toBe(`${local}+tag@example.photography`);

    const agent = newAgent();
    await csrf(agent);
    const invalid = await agent.post('/api/auth/register').send(registrationBody({ email: 'not-an-email' }));
    expect(expectProblem(invalid, 422, 'validation-failed').errors).toEqual([
      { location: 'body', path: 'email', message: 'Please enter a valid email address.' },
    ]);
  });

  it('F-10, B-10, B-11: an existing email in another case is 409 email-taken with the field error on email', async () => {
    const first = await register(newAgent());

    const agent = newAgent();
    const anonymous = await anonymousToken(agent);
    const response = await agent
      .post('/api/auth/register')
      .send(registrationBody({ email: ` ${first.email.toUpperCase()} ` }));

    const problem = expectProblem(response, 409, 'email-taken');
    expect(problem).toMatchObject({ status: 409, instance: '/api/auth/register' });
    expect(problem.errors).toEqual([
      { location: 'body', path: 'email', message: 'An account with this email already exists.' },
    ]);
    // Nobody was signed in: the visitor keeps the anonymous session (renewed by `rolling`, not regenerated).
    expect(sessionIdOf(response)).toBe(anonymous.sessionId);
    expect(await storedSession(anonymous.sessionId)).not.toHaveProperty('userId');
    const rows = await testApp.db.select({ id: users.id }).from(users).where(eq(users.email, first.email));
    expect(rows).toEqual([{ id: first.user.id }]);
  });

  it('F-09: 11 characters are 422, 12 and 256 are accepted, 257 are 422', async () => {
    const agent = newAgent();
    await csrf(agent);
    const tooShort = await agent.post('/api/auth/register').send(registrationBody({ password: 'a'.repeat(11) }));
    expect(expectProblem(tooShort, 422, 'validation-failed').errors).toEqual([
      { location: 'body', path: 'password', message: 'Use at least 12 characters.' },
    ]);
    const tooLong = await agent.post('/api/auth/register').send(registrationBody({ password: 'a'.repeat(257) }));
    expect(expectProblem(tooLong, 422, 'validation-failed').errors).toEqual([
      expect.objectContaining({ location: 'body', path: 'password' }),
    ]);

    await register(newAgent(), { password: 'a'.repeat(12) });
    await register(newAgent(), { password: 'b'.repeat(256) });
  });

  it('F-09: the password is never trimmed (composition and blanks are kept as typed)', async () => {
    const password = '  twelve chars  ';
    const { email } = await register(newAgent(), { password });

    const agent = newAgent();
    await csrf(agent);
    expectProblem(
      await agent.post('/api/auth/login').send({ email, password: password.trim() }),
      401,
      'invalid-credentials',
    );
    await login(agent, { email, password });
  });

  it('B-09: every invalid field is reported at once, and nothing is stored', async () => {
    const agent = newAgent();
    await csrf(agent);
    const email = uniqueEmail();

    const response = await agent
      .post('/api/auth/register')
      .send({ firstName: 5, lastName: '', email: `${email}@`, password: 'short' });

    const problem = expectProblem(response, 422, 'validation-failed');
    expect(problem.errors?.map(({ path }) => path).sort()).toEqual(['email', 'firstName', 'lastName', 'password']);
    expect(problem.errors?.every(({ location }) => location === 'body')).toBe(true);

    const empty = await agent.post('/api/auth/register').send({});
    expect(expectProblem(empty, 422, 'validation-failed').errors).toHaveLength(4);
    expect(await testApp.db.select().from(users).where(eq(users.email, email))).toEqual([]);
  });

  it('B-09, B-50: malformed JSON is 400 invalid-request and the body is never echoed', async () => {
    const agent = newAgent();
    await csrf(agent);

    const response = await agent
      .post('/api/auth/register')
      .set('content-type', 'application/json')
      .send('{"email": "a@example.com", "password": "hunter2-hunter2');

    expect(expectProblem(response, 400, 'invalid-request').detail).toBe('The request body is not valid JSON.');
    expect(response.text).not.toContain('hunter2');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------------------------------------------

describe('POST /api/auth/login', () => {
  it('F-14, F-18, B-19: the right credentials answer 200 AuthResponse with a regenerated session', async () => {
    const row = await insertUser(testApp.db, { firstName: 'Mira', lastName: 'Novak', bio: 'Hello.' });
    const agent = newAgent();
    const anonymous = await anonymousToken(agent);

    const response = await agent
      .post('/api/auth/login')
      .send({ email: row.email, password: TEST_USER_PASSWORD })
      .expect(200);

    const { user, csrfToken } = AuthResponse.parse(response.body);
    expect(user).toEqual({ id: row.id, firstName: 'Mira', lastName: 'Novak', bio: 'Hello.', avatarUrl: null });
    expect(response.text).not.toContain(row.email);
    expect(response.text).not.toContain('$argon2');

    const sessionId = sessionIdOf(response);
    expect(sessionId).not.toBe(anonymous.sessionId);
    expect(await storedSession(anonymous.sessionId)).toBeNull();
    expect(await storedSession(sessionId)).toMatchObject({ userId: row.id });
    expect(expiresInSeconds(cookieLine(response, SESSION_COOKIE))).toBeGreaterThan(7 * DAY_S - 60);
    await agent.post('/api/auth/logout').set(CSRF_HEADER, csrfToken).expect(204);
  });

  it('F-14, ADR-0010: the user of an account with an avatar gets its avatar URL', async () => {
    const row = await insertUser(testApp.db, { avatar: true });
    const agent = newAgent();

    const { user } = await login(agent, { email: row.email, password: TEST_USER_PASSWORD });

    const version = row.avatarKey?.split('/')[2]?.replace('.webp', '');
    expect(user.avatarUrl).toBe(`/api/users/${String(row.id)}/avatar?v=${String(version)}`);
  });

  it('F-18: logging in again from a signed-in session rotates the id again', async () => {
    const row = await insertUser(testApp.db);
    const agent = newAgent();
    const first = await login(agent, { email: row.email, password: TEST_USER_PASSWORD });

    const second = await login(agent, { email: row.email, password: TEST_USER_PASSWORD });

    expect(sessionIdOf(second.response)).not.toBe(sessionIdOf(first.response));
    expect(await storedSession(sessionIdOf(first.response))).toBeNull();
    expectProblem(await agent.post('/api/auth/logout').set(CSRF_HEADER, first.csrfToken), 403, 'csrf-invalid');
  });

  it('B-10: the email matches in any case and with surrounding blanks', async () => {
    const row = await insertUser(testApp.db);

    const { user } = await login(newAgent(), { email: `  ${row.email.toUpperCase()}\t`, password: TEST_USER_PASSWORD });

    expect(user.id).toBe(row.id);
  });

  it('F-15, B-12, B-13: an unknown email and a wrong password get the identical 401, and nobody is signed in', async () => {
    const row = await insertUser(testApp.db);
    const agent = newAgent();
    const anonymous = await anonymousToken(agent);

    const unknown = await agent.post('/api/auth/login').send({ email: uniqueEmail(), password: TEST_USER_PASSWORD });
    const wrong = await agent.post('/api/auth/login').send({ email: row.email, password: 'not the password at all' });

    const unknownProblem = expectProblem(unknown, 401, 'invalid-credentials');
    expect(expectProblem(wrong, 401, 'invalid-credentials')).toEqual(unknownProblem);
    expect(unknownProblem).toEqual({
      type: `${PROBLEM_TYPE_PREFIX}invalid-credentials`,
      title: 'Unauthorized',
      status: 401,
      detail: 'Email or password is incorrect.',
      instance: '/api/auth/login',
    });
    // `rolling` renews the visitor's cookie on both answers, with the same, unregenerated id.
    expect(sessionIdOf(unknown)).toBe(anonymous.sessionId);
    expect(sessionIdOf(wrong)).toBe(anonymous.sessionId);
    expect(await storedSession(anonymous.sessionId)).not.toHaveProperty('userId');
    expectProblem(await agent.post('/api/auth/logout'), 401, 'unauthorized');
  });

  it('F-15, B-13: an unknown email takes about as long as a wrong password (one argon2id verify each)', async () => {
    const row = await insertUser(testApp.db);
    const agent = newAgent();
    await csrf(agent);
    const timed = async (email: string): Promise<number> => {
      const started = performance.now();
      await agent.post('/api/auth/login').send({ email, password: 'not the password at all' }).expect(401);
      return performance.now() - started;
    };
    const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

    const unknown: number[] = [];
    const wrong: number[] = [];
    for (let round = 0; round < 5; round++) {
      unknown.push(await timed(uniqueEmail()));
      wrong.push(await timed(row.email));
    }

    // Without the dummy verify an unknown email answers after one indexed query, orders of magnitude faster.
    const ratio = median(unknown) / median(wrong);
    expect(ratio).toBeGreaterThan(1 / 3);
    expect(ratio).toBeLessThan(3);
  });

  it('F-15: the length policy is not revealed on login: a short wrong password is 401, an empty one 422', async () => {
    const row = await insertUser(testApp.db);
    const agent = newAgent();
    await csrf(agent);

    expectProblem(
      await agent.post('/api/auth/login').send({ email: row.email, password: 'short' }),
      401,
      'invalid-credentials',
    );
    const empty = await agent.post('/api/auth/login').send({ email: row.email, password: '' });
    expect(expectProblem(empty, 422, 'validation-failed').errors).toEqual([
      expect.objectContaining({ location: 'body', path: 'password' }),
    ]);
  });

  it('F-17, B-16: a login with an outdated hash upgrades it to the pinned argon2id parameters', async () => {
    const password = 'an older account password';
    const outdated = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const row = await insertUser(testApp.db, { passwordHash: outdated });

    await login(newAgent(), { email: row.email, password });

    const upgraded = (await storedUser(row.id)).passwordHash;
    expect(upgraded).not.toBe(outdated);
    expect(upgraded).toMatch(PINNED_ARGON2ID);
    expect(argon2Hasher.needsRehash(upgraded)).toBe(false);
    await login(newAgent(), { email: row.email, password });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------------------------------------------

describe('POST /api/auth/logout', () => {
  it('F-20, B-17: 204, destroys the session in Redis and clears the cookie; the old cookie is then worthless', async () => {
    const agent = newAgent();
    const { response: registered } = await register(agent);
    const oldCookie = cookiePair(registered, SESSION_COOKIE);
    const sessionId = sessionIdOf(registered);

    const response = await agent.post('/api/auth/logout').expect(204);

    expect(response.text).toBe('');
    const cleared = cookieLine(response, SESSION_COOKIE);
    expect(cleared).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cleared).toMatch(/; Path=\/(;|$)/);
    expect(cleared).toMatch(/; HttpOnly(;|$)/);
    expect(cleared).toMatch(/; SameSite=Lax(;|$)/);
    expect(await storedSession(sessionId)).toBeNull();

    // A replayed copy of the old cookie no longer names a session (B-17: server-side invalidation).
    expectProblem(await request(testApp.app).get('/api/me').set('Cookie', oldCookie), 401, 'unauthorized');
  });

  it("F-20: closes every socket of this session and none of the user's other sessions", async () => {
    const agentA = newAgent();
    const credentials = await register(agentA);
    const agentB = newAgent();
    const { response: loggedInB } = await login(agentB, credentials);
    const socketA = track(await connectAs(agentA, testApp));
    const socketB = track(await connectAs(agentB, testApp));
    const disconnected = waitForDisconnect(socketA);

    await agentA.post('/api/auth/logout').expect(204);

    expect(await disconnected).toBe('io server disconnect');
    const remaining = await testApp.io.in(rooms.session(sessionIdOf(loggedInB))).fetchSockets();
    expect(remaining.map(({ id }) => id)).toEqual([socketB.id]);
    expect(socketB.connected).toBe(true);
  });

  it('F-20, B-20: without a signed-in session it is 401 unauthorized', async () => {
    const agent = newAgent();
    await anonymousToken(agent);

    expectProblem(await agent.post('/api/auth/logout'), 401, 'unauthorized');
  });

  it('B-18: GET /api/auth/logout is the 404 problem and leaves the session alone', async () => {
    const agent = newAgent();
    const { user, response: registered } = await register(agent);

    expectProblem(await agent.get('/api/auth/logout'), 404, 'not-found');

    expect(await storedSession(sessionIdOf(registered))).toMatchObject({ userId: user.id });
  });

  it('F-23, B-58: after logout a fresh token from GET /api/csrf-token logs in again without a reload', async () => {
    const agent = newAgent();
    const credentials = await register(agent);
    await agent.post('/api/auth/logout').expect(204);

    // The token of the destroyed session is worthless for the next login ...
    expectProblem(
      await agent.post('/api/auth/login').set(CSRF_HEADER, credentials.csrfToken).send(credentials),
      403,
      'csrf-invalid',
    );
    // ... the SPA fetches a new one and logs in with it (login() does exactly that).
    const again = await login(agent, credentials);
    expect(again.user.id).toBe(credentials.user.id);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Failures are HTTP errors (B-54)
// ---------------------------------------------------------------------------------------------------------------

describe('B-54: every failed auth request has an error status', () => {
  it('B-54: register, login and logout failures are 4xx problem+json, never 200 with a success flag', async () => {
    const existing = await register(newAgent());
    const visitor = newAgent();
    await anonymousToken(visitor);

    const failures = [
      {
        label: 'register with a taken email',
        response: await visitor.post('/api/auth/register').send(registrationBody({ email: existing.email })),
        status: 409,
        code: 'email-taken',
      },
      {
        label: 'register with invalid fields',
        response: await visitor.post('/api/auth/register').send({ firstName: '', email: 'nope', password: 'short' }),
        status: 422,
        code: 'validation-failed',
      },
      {
        label: 'register with malformed JSON',
        response: await visitor.post('/api/auth/register').set('Content-Type', 'application/json').send('{"email":'),
        status: 400,
        code: 'invalid-request',
      },
      {
        label: 'register without the CSRF token',
        response: await visitor.post('/api/auth/register').unset(CSRF_HEADER).send(registrationBody()),
        status: 403,
        code: 'csrf-invalid',
      },
      {
        label: 'login with a wrong password',
        response: await visitor.post('/api/auth/login').send({ email: existing.email, password: 'not the password' }),
        status: 401,
        code: 'invalid-credentials',
      },
      {
        label: 'login without a password',
        response: await visitor.post('/api/auth/login').send({ email: existing.email }),
        status: 422,
        code: 'validation-failed',
      },
      {
        label: 'logout without a session',
        response: await visitor.post('/api/auth/logout'),
        status: 401,
        code: 'unauthorized',
      },
    ] as const satisfies readonly { label: string; response: Response; status: number; code: ProblemCode }[];

    for (const { label, response, status, code } of failures) {
      expect(response.status, label).toBe(status);
      expectProblem(response, status, code);
      // The legacy answers were `200 { success: false }` or `200 {}`; nothing of that shape is left.
      expect(response.body, label).not.toHaveProperty('success');
      expect(response.body, label).not.toHaveProperty('user');
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------------------------------------------

describe('CSRF on the auth routes', () => {
  it('F-23: register, login and logout without x-csrf-token are 403 csrf-invalid and change nothing', async () => {
    const signedIn = newAgent();
    const { user, email, password, response: registered } = await register(signedIn);
    const visitor = newAgent();
    await anonymousToken(visitor);
    const body = registrationBody();

    expectProblem(await visitor.post('/api/auth/register').unset(CSRF_HEADER).send(body), 403, 'csrf-invalid');
    expectProblem(
      await visitor.post('/api/auth/login').unset(CSRF_HEADER).send({ email, password }),
      403,
      'csrf-invalid',
    );
    expectProblem(await signedIn.post('/api/auth/logout').unset(CSRF_HEADER), 403, 'csrf-invalid');

    expect(await testApp.db.select().from(users).where(eq(users.email, body.email))).toEqual([]);
    expect(await storedSession(sessionIdOf(registered))).toMatchObject({ userId: user.id });
  });

  it('B-58: only the token endpoint, register and login set the CSRF cookie, never a failed login or logout', async () => {
    const row = await insertUser(testApp.db);
    const agent = newAgent();
    const tokenResponse = await agent.get('/api/csrf-token').expect(200);
    expect(cookieLine(tokenResponse, CSRF_COOKIE)).toBeDefined();
    agent.set(CSRF_HEADER, CsrfTokenResponse.parse(tokenResponse.body).token);

    const failed = await agent.post('/api/auth/login').send({ email: row.email, password: 'not the password at all' });
    expect(failed.status).toBe(401);
    expect(cookieLine(failed, CSRF_COOKIE)).toBeUndefined();

    const { response: loggedIn } = await login(agent, { email: row.email, password: TEST_USER_PASSWORD });
    expect(cookieLine(loggedIn, CSRF_COOKIE)).toBeDefined();

    const loggedOut = await agent.post('/api/auth/logout').expect(204);
    expect(cookieLine(loggedOut, CSRF_COOKIE)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Configurable session lifetime
// ---------------------------------------------------------------------------------------------------------------

describe('session lifetime (SESSION_TTL_DAYS)', () => {
  let shortApp: TestApp;

  beforeAll(async () => {
    shortApp = await createTestApp({ env: { SESSION_TTL_DAYS: '3' } });
  });

  afterAll(async () => {
    await shortApp.close();
  });

  it('F-19: the signed-in session expires after the configured idle time, in the cookie and in Redis', async () => {
    const { response } = await register(newAgent(shortApp));

    const expires = expiresInSeconds(cookieLine(response, SESSION_COOKIE));
    expect(expires).toBeGreaterThan(3 * DAY_S - 60);
    expect(expires).toBeLessThanOrEqual(3 * DAY_S);
    const ttl = await shortApp.redis.ttl(sessionKey(shortApp, sessionIdOf(response)));
    expect(ttl).toBeGreaterThan(3 * DAY_S - 60);
    expect(ttl).toBeLessThanOrEqual(3 * DAY_S);
  });
});
