import { randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';

import type { UserSummary } from '@app/shared';
import { eq } from 'drizzle-orm';
import { io as connectClient } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveLimits, type Limits } from '../src/config/limits.js';
import { users } from '../src/db/schema/index.js';
import { rooms } from '../src/shared/realtime/rooms.js';
import { MAX_SOCKETS_PER_USER } from '../src/shared/realtime/socket-auth.js';
import { SOCKET_PATH } from '../src/shared/realtime/socket-server.js';
import { sessionCookieName, sessionKeyPrefix } from '../src/shared/security/session.js';
import { insertUser, type UserRow } from './db.js';
import { csrf, signIn, type TestAgent } from './http.js';
import { connectAs, waitFor, waitForDisconnect, type TestSocket } from './socket.js';
import {
  createTestApp,
  TEST_ORIGIN,
  TEST_RATE_LIMIT_MULTIPLIER,
  type TestApp,
  type TestAppOptions,
} from './test-app.js';

/**
 * The realtime part of the composed app (OVERVIEW §8, API.md §3, ADR-0005, ADR-0008): the real `createApp` with every
 * module, its socket handshake chain and the DB-backed user loader, the real socket.io server on an ephemeral port and
 * sessions in the run's Redis 8. Agents sign in through the test-only route (`signIn()`), and the 60 s session sweep
 * is triggered on demand with `sessionGuard.sweep()`.
 *
 * The kernel itself (each middleware in isolation, publisher, ack pipeline) is proven in
 * `src/shared/realtime/__tests__/socket-server.int.test.ts`; this file proves that the app wires it with the
 * production rules: the `CORS_ORIGINS` allow-list, `limits.socketHandshake`, `TRUST_PROXY`, the cap of 10 sockets
 * per user, and the session store the HTTP side writes. HTTP-only parts of F-04, F-106, F-109 and F-114 live in
 * `test/app.int.test.ts`.
 */

const SESSION_COOKIE = sessionCookieName(false);
/** engine.io's answer to a request it refuses before the upgrade (`abortRequest` / `abortUpgrade`). */
const ENGINE_BAD_REQUEST = 400;

/** Every client socket a test opened; closed after each test so no test leaks connections into the next one. */
const openSockets: TestSocket[] = [];

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.close();
});

function track(socket: TestSocket): TestSocket {
  openSockets.push(socket);
  return socket;
}

/** A user row plus an agent signed in as that user (a fresh session with the normal TTL). */
async function signedInAgent(testApp: TestApp, user?: UserRow): Promise<{ user: UserRow; agent: TestAgent }> {
  const row = user ?? (await insertUser(testApp.db));
  const agent = request.agent(testApp.app);
  await signIn(agent, row.id);
  return { user: row, agent };
}

async function connected(testApp: TestApp, agent: TestAgent): Promise<TestSocket> {
  return track(await connectAs(agent, testApp));
}

/** The `connect_error` of a handshake that must fail; a handshake that succeeds fails the test. */
async function rejection(promise: Promise<TestSocket>): Promise<Error & { data?: unknown }> {
  const result = await promise.then(
    (socket) => {
      track(socket);
      return null;
    },
    (error: unknown) => error,
  );
  if (!(result instanceof Error)) throw new Error('expected the handshake to be rejected, but it connected');
  return result;
}

/** The agent's cookies as a `Cookie` request header for the socket path (what `connectAs` sends). */
function cookieHeaderOf(agent: TestAgent): string {
  return agent.jar
    .getCookies({ domain: '127.0.0.1', path: `${SOCKET_PATH}/`, secure: false, script: false })
    .toValueString();
}

/** The raw (URL-decoded) value of the agent's express-session cookie, `''` without one. */
function sessionCookieValue(agent: TestAgent): string {
  const cookie = agent.jar
    .getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false })
    .find(({ name }) => name === SESSION_COOKIE);
  return decodeURIComponent(cookie?.value ?? '');
}

/** Replaces the agent's session cookie, as a client that forges or replays one would. */
function setSessionCookie(agent: TestAgent, value: string): void {
  agent.jar.setCookie(`${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly`, '127.0.0.1', '/');
  expect(sessionCookieValue(agent)).toBe(value);
}

/** The session id inside the agent's signed express-session cookie (`s:<id>.<signature>`). */
function sessionIdOf(agent: TestAgent): string {
  const sessionId = /^s:(.+)\.[^.]+$/.exec(sessionCookieValue(agent))?.[1];
  if (sessionId === undefined) throw new Error('the agent has no signed session cookie');
  return sessionId;
}

function sessionKey(testApp: TestApp, sessionId: string): string {
  return sessionKeyPrefix(testApp.prefix) + sessionId;
}

/** The server-side sockets of one user (members of `rooms.user(id)`). */
async function serverSocketsOf(testApp: TestApp, userId: number) {
  return testApp.io.in(rooms.user(userId)).fetchSockets();
}

/** Waits (polling, never sleeping blindly) until the server counts exactly `count` open sockets for the user. */
async function expectServerSocketCount(testApp: TestApp, userId: number, count: number): Promise<void> {
  await vi.waitFor(async () => {
    expect(await serverSocketsOf(testApp, userId)).toHaveLength(count);
  });
}

interface RawUpgradeResult {
  /** 101 when engine.io accepted the WebSocket upgrade, else the status of the refusal. */
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * A bare WebSocket upgrade request to the socket path, as a browser (or an attacker's script) sends it, without
 * socket.io-client in between: proves *where* a handshake is refused (before the upgrade, or after it).
 */
function rawUpgrade(baseUrl: string, headers: Record<string, string>): Promise<RawUpgradeResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${baseUrl}${SOCKET_PATH}/?EIO=4&transport=websocket`, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.once('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode ?? 0, headers: response.headers, body: '' });
    });
    req.once('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.once('end', () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
      });
      response.once('error', reject);
    });
    req.once('error', reject);
    req.end();
  });
}

/** A WebSocket-only client with arbitrary extra headers (e.g. `X-Forwarded-For`), which `connectAs` cannot send. */
function connectWithHeaders(testApp: TestApp, agent: TestAgent, headers: Record<string, string>): Promise<TestSocket> {
  const cookie = cookieHeaderOf(agent);
  const socket: TestSocket = connectClient(testApp.baseUrl, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    extraHeaders: { origin: TEST_ORIGIN, ...(cookie ? { cookie } : {}), ...headers },
    reconnection: false,
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => {
      socket.off('connect_error');
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      socket.off('connect');
      socket.close();
      reject(error);
    });
  });
}

/** The test limits with an exact handshake budget per IP (every other limit stays × 100). */
function handshakeLimits(limit: number): Limits {
  return {
    ...resolveLimits({ RATE_LIMIT_MULTIPLIER: TEST_RATE_LIMIT_MULTIPLIER }),
    socketHandshake: { limit, windowMs: 60_000 },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Handshake: origin allow-list
// ---------------------------------------------------------------------------------------------------------------

describe('handshake: origin allow-list (F-111, B-07)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-111: a signed-in agent from the allow-listed origin connects over WebSocket as its user, in its rooms', async () => {
    const { user, agent } = await signedInAgent(testApp);

    const socket = await connected(testApp, agent);

    expect(socket.io.engine.transport.name).toBe('websocket');
    const [server, ...others] = await serverSocketsOf(testApp, user.id);
    expect(others).toHaveLength(0);
    // The handshake loaded the public summary once from the database: no email, no password hash (B-19, B-75).
    const summary: UserSummary = { id: user.id, firstName: user.firstName, lastName: user.lastName, avatarUrl: null };
    expect(server?.data).toStrictEqual({ user: summary, sessionId: sessionIdOf(agent) });
    expect([...(server?.rooms ?? [])].sort()).toEqual(
      [socket.id, rooms.chat, rooms.session(sessionIdOf(agent)), rooms.user(user.id)].sort(),
    );
  });

  it('B-07: the allow-listed origin passes the upgrade (101); authentication is the next, separate layer', async () => {
    const result = await rawUpgrade(testApp.baseUrl, { origin: TEST_ORIGIN });

    expect(result.status).toBe(101);
  });

  it.each([
    ['a foreign site', 'https://evil.example'],
    ['the allowed host on another port', 'http://127.0.0.1:5174'],
    ['the allowed port on another host name', 'http://localhost:5173'],
    ['https instead of http', 'https://127.0.0.1:5173'],
    ['a suffix attack on the allowed origin', 'http://127.0.0.1:5173.evil.example'],
    ['an origin with a path', `${TEST_ORIGIN}/`],
    ['the opaque origin "null" (sandboxed iframe, file://)', 'null'],
  ])('B-07: refuses %s before the upgrade, even with a valid session', async (_label, origin) => {
    const { user, agent } = await signedInAgent(testApp);

    const raw = await rawUpgrade(testApp.baseUrl, { origin, cookie: cookieHeaderOf(agent) });
    expect(raw.status).toBe(ENGINE_BAD_REQUEST);
    expect(raw.body).toBe('origin not allowed');
    expect(raw.body).not.toContain(origin);

    // socket.io-client only sees the failed WebSocket, never a socket.io CONNECT.
    expect((await rejection(connectAs(agent, { baseUrl: testApp.baseUrl, origin }))).message).toBe('websocket error');
    expect(await serverSocketsOf(testApp, user.id)).toHaveLength(0);
  });

  it('B-07, B-38: refuses a handshake without an Origin header (non-browser clients), even with a valid session', async () => {
    const { user, agent } = await signedInAgent(testApp);

    const raw = await rawUpgrade(testApp.baseUrl, { cookie: cookieHeaderOf(agent) });
    expect(raw.status).toBe(ENGINE_BAD_REQUEST);
    expect(raw.body).toBe('origin not allowed');

    const error = await rejection(connectAs(agent, { baseUrl: testApp.baseUrl, origin: null }));
    expect(error.message).toBe('websocket error');
    expect(await serverSocketsOf(testApp, user.id)).toHaveLength(0);
  });

  it('B-07: an origin-refused handshake never spends the handshake budget of its IP', async () => {
    const limited = await createTestApp({ limits: handshakeLimits(1) });
    try {
      const { agent } = await signedInAgent(limited);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await rejection(connectAs(agent, { baseUrl: limited.baseUrl, origin: 'https://evil.example' }));
      }

      // The single allowed handshake of this IP is still unused.
      await connected(limited, agent);
    } finally {
      await limited.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The socket path is not a page (WebSocket only)
// ---------------------------------------------------------------------------------------------------------------

describe('the socket path (F-04, B-57, F-106, B-59)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it.each([
    ['the long-polling transport', `${SOCKET_PATH}/?EIO=4&transport=polling`],
    ['the socket.io client bundle (serveClient off)', `${SOCKET_PATH}/socket.io.js`],
    ['an unknown path below the socket path', `${SOCKET_PATH}/does-not-exist`],
  ])(
    'F-04, B-57: %s is refused by engine.io with a JSON error, never an HTML page or a script',
    async (_label, path) => {
      const response = await request(testApp.baseUrl).get(path).set('origin', TEST_ORIGIN);

      expect(response.status).toBe(ENGINE_BAD_REQUEST);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.text).not.toMatch(/<html|<!doctype|function\s*\(/i);
      // F-106: a fixed code and message, no stack trace or internal detail.
      expect(response.body).toStrictEqual({
        code: expect.any(Number) as number,
        message: expect.any(String) as string,
      });
      expect(response.text).not.toMatch(/\bat\s+\S+\s+\(|node_modules/);
    },
  );

  it('B-07, B-59: answers a foreign origin without CORS grants and without x-powered-by', async () => {
    const response = await request(testApp.baseUrl)
      .get(`${SOCKET_PATH}/?EIO=4&transport=polling`)
      .set('origin', 'https://evil.example');

    expect(response.status).toBe(ENGINE_BAD_REQUEST);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Handshake: authentication
// ---------------------------------------------------------------------------------------------------------------

describe('handshake: authentication (F-111, B-38)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('B-38: rejects a socket without any session cookie as unauthorized, with nothing but the code (F-106)', async () => {
    const error = await rejection(connectAs(request.agent(testApp.app), testApp));

    expect(error.message).toBe('unauthorized');
    expect(error.data).toBeUndefined();
    expect(testApp.io.sockets.sockets.size).toBe(0);
  });

  it('B-38: rejects the anonymous session that GET /api/csrf-token binds (a session, but no user)', async () => {
    const agent = request.agent(testApp.app);
    await csrf(agent);
    expect(await testApp.redis.exists(sessionKey(testApp, sessionIdOf(agent)))).toBe(1);

    const error = await rejection(connectAs(agent, testApp));

    expect(error.message).toBe('unauthorized');
  });

  it('B-38: rejects a signed-in session cookie whose signature was tampered with', async () => {
    const { agent } = await signedInAgent(testApp);
    const sessionId = sessionIdOf(agent);
    expect(await testApp.redis.exists(sessionKey(testApp, sessionId))).toBe(1);
    setSessionCookie(agent, `s:${sessionId}.${'A'.repeat(43)}`);

    const error = await rejection(connectAs(agent, testApp));

    expect(error.message).toBe('unauthorized');
  });

  it('B-38: rejects a session id taken from Redis without the signed cookie (unsigned value)', async () => {
    const { agent } = await signedInAgent(testApp);
    const sessionId = sessionIdOf(agent);
    expect(await testApp.redis.exists(sessionKey(testApp, sessionId))).toBe(1);
    setSessionCookie(agent, sessionId);

    const error = await rejection(connectAs(agent, testApp));

    expect(error.message).toBe('unauthorized');
  });

  it('F-111: rejects the cookie of a session that ended before the handshake (expired or destroyed)', async () => {
    const { user, agent } = await signedInAgent(testApp);
    await testApp.redis.del(sessionKey(testApp, sessionIdOf(agent)));

    const error = await rejection(connectAs(agent, testApp));

    expect(error.message).toBe('unauthorized');
    expect(await serverSocketsOf(testApp, user.id)).toHaveLength(0);
  });

  it('B-38: rejects a valid session whose user no longer exists', async () => {
    const { user, agent } = await signedInAgent(testApp);
    await testApp.db.delete(users).where(eq(users.id, user.id));

    const error = await rejection(connectAs(agent, testApp));

    expect(error.message).toBe('unauthorized');
  });

  it('F-111: a second sign-in rotates the session; only the new cookie opens a socket', async () => {
    const { user, agent } = await signedInAgent(testApp);
    const oldCookie = sessionCookieValue(agent);
    const oldSessionId = sessionIdOf(agent);

    await signIn(agent, user.id);
    expect(sessionIdOf(agent)).not.toBe(oldSessionId);
    const socket = await connected(testApp, agent);
    expect(socket.connected).toBe(true);

    // Replaying the old, correctly signed cookie (e.g. from another tab) no longer opens a socket.
    const stale = request.agent(testApp.app);
    setSessionCookie(stale, oldCookie);
    const error = await rejection(connectAs(stale, testApp));
    expect(error.message).toBe('unauthorized');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Handshake: limits
// ---------------------------------------------------------------------------------------------------------------

describe('handshake: rate limit per IP (F-111, B-38)', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.close();
    testApp = undefined;
  });

  async function start(options: TestAppOptions): Promise<TestApp> {
    testApp = await createTestApp(options);
    return testApp;
  }

  it('B-38: the app applies limits.socketHandshake and reports rate-limited with only retryAfterMs (F-106)', async () => {
    const app = await start({ limits: handshakeLimits(2) });
    const { agent } = await signedInAgent(app);
    await connected(app, agent);
    await connected(app, agent);

    const error = await rejection(connectAs(agent, app));

    expect(error.message).toBe('rate-limited');
    expect(error.data).toStrictEqual({ retryAfterMs: expect.any(Number) as number });
    const { retryAfterMs } = error.data as { retryAfterMs: number };
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('B-38: anonymous handshakes spend the same budget, so probing cannot bypass the limit', async () => {
    const app = await start({ limits: handshakeLimits(2) });
    const anonymous = request.agent(app.app);
    expect((await rejection(connectAs(anonymous, app))).message).toBe('unauthorized');
    expect((await rejection(connectAs(anonymous, app))).message).toBe('unauthorized');

    const { agent } = await signedInAgent(app);
    expect((await rejection(connectAs(agent, app))).message).toBe('rate-limited');
  });

  it('B-38: without a trusted proxy (TRUST_PROXY=0) a spoofed X-Forwarded-For does not buy a new budget', async () => {
    const app = await start({ limits: handshakeLimits(2) });
    const { agent } = await signedInAgent(app);
    track(await connectWithHeaders(app, agent, { 'x-forwarded-for': '203.0.113.1' }));
    track(await connectWithHeaders(app, agent, { 'x-forwarded-for': '203.0.113.2' }));

    const error = await rejection(connectWithHeaders(app, agent, { 'x-forwarded-for': '203.0.113.3' }));

    expect(error.message).toBe('rate-limited');
  });

  it('F-111: behind one trusted proxy (TRUST_PROXY=1) the limit holds per forwarded client', async () => {
    const app = await start({ limits: handshakeLimits(2), env: { TRUST_PROXY: '1' } });
    const { agent } = await signedInAgent(app);
    const first = { 'x-forwarded-for': '203.0.113.10' };
    const second = { 'x-forwarded-for': '203.0.113.20' };
    track(await connectWithHeaders(app, agent, first));
    track(await connectWithHeaders(app, agent, first));

    expect((await rejection(connectWithHeaders(app, agent, first))).message).toBe('rate-limited');
    // Another client behind the same proxy keeps its own budget.
    track(await connectWithHeaders(app, agent, second));
  });
});

describe('handshake: open sockets per user (F-111, B-38)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('B-38: caps a user at 10 open sockets across sessions, independent of other users, and frees closed slots', async () => {
    expect(MAX_SOCKETS_PER_USER).toBe(10);
    const { user, agent } = await signedInAgent(testApp);
    const sockets: TestSocket[] = [];
    for (let index = 0; index < MAX_SOCKETS_PER_USER; index += 1) sockets.push(await connected(testApp, agent));
    expect(await serverSocketsOf(testApp, user.id)).toHaveLength(MAX_SOCKETS_PER_USER);

    // Same session and a second session (another device) of the same user are both over the cap (F-106: only a code).
    const sameSession = await rejection(connectAs(agent, testApp));
    expect(sameSession.message).toBe('too-many-connections');
    expect(sameSession.data).toBeUndefined();
    const { agent: otherDevice } = await signedInAgent(testApp, user);
    expect((await rejection(connectAs(otherDevice, testApp))).message).toBe('too-many-connections');
    expect(await serverSocketsOf(testApp, user.id)).toHaveLength(MAX_SOCKETS_PER_USER);

    // Another user is not affected by this user's cap.
    const { agent: otherUser } = await signedInAgent(testApp);
    await connected(testApp, otherUser);

    // Closing one socket frees exactly one slot.
    sockets[0]?.close();
    await expectServerSocketCount(testApp, user.id, MAX_SOCKETS_PER_USER - 1);
    await connected(testApp, otherDevice);
    expect((await rejection(connectAs(agent, testApp))).message).toBe('too-many-connections');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Session lifetime: the periodic sweep
// ---------------------------------------------------------------------------------------------------------------

describe('session lifetime: sessionGuard.sweep() (F-111, B-38, ADR-0005)', () => {
  let testApp: TestApp;

  // A fresh app per test, so the sweep's counts cover exactly this test's sockets.
  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp.close();
  });

  it('B-38: disconnects every socket of a session whose TTL ran out and keeps serving the live ones', async () => {
    const expiring = await signedInAgent(testApp);
    const live = await signedInAgent(testApp);
    const expiringTabs = [await connected(testApp, expiring.agent), await connected(testApp, expiring.agent)];
    const liveSocket = await connected(testApp, live.agent);
    const disconnects = expiringTabs.map((socket) => waitForDisconnect(socket));

    // The real expiry path: Redis drops the key when its TTL runs out (connect-redis sets it from the cookie).
    const key = sessionKey(testApp, sessionIdOf(expiring.agent));
    expect(await testApp.redis.pTTL(key)).toBeGreaterThan(0);
    await testApp.redis.pExpire(key, 1);
    await vi.waitFor(async () => {
      expect(await testApp.redis.exists(key)).toBe(0);
    });

    await expect(testApp.sessionGuard.sweep()).resolves.toStrictEqual({ checked: 2, disconnected: 1 });

    // `io server disconnect` is the reason the web client turns into `sessionExpired` (it never retries it).
    await expect(Promise.all(disconnects)).resolves.toEqual(['io server disconnect', 'io server disconnect']);
    await expectServerSocketCount(testApp, expiring.user.id, 0);
    expect(liveSocket.connected).toBe(true);
    const delivered = waitFor(liveSocket, 'presence:left', { filter: ({ userId }) => userId === expiring.user.id });
    testApp.io.to(rooms.chat).emit('presence:left', { userId: expiring.user.id });
    await expect(delivered).resolves.toEqual({ userId: expiring.user.id });
  });

  it('F-111: after a re-login the old session’s sockets are swept, the new session’s socket stays', async () => {
    const { user, agent } = await signedInAgent(testApp);
    const oldSocket = await connected(testApp, agent);
    const oldSessionId = sessionIdOf(agent);
    const disconnected = waitForDisconnect(oldSocket);

    // A new login regenerates the session id; express-session destroys the old one in Redis.
    await signIn(agent, user.id);
    expect(sessionIdOf(agent)).not.toBe(oldSessionId);
    expect(await testApp.redis.exists(sessionKey(testApp, oldSessionId))).toBe(0);
    const newSocket = await connected(testApp, agent);

    await expect(testApp.sessionGuard.sweep()).resolves.toStrictEqual({ checked: 2, disconnected: 1 });

    await expect(disconnected).resolves.toBe('io server disconnect');
    expect(newSocket.connected).toBe(true);
    const [server, ...others] = await serverSocketsOf(testApp, user.id);
    expect(others).toHaveLength(0);
    expect(server?.data.sessionId).toBe(sessionIdOf(agent));
  });

  it('F-111: a sweep with only live sessions disconnects nothing; a swept user can sign in and connect again', async () => {
    const { user, agent } = await signedInAgent(testApp);
    const socket = await connected(testApp, agent);

    await expect(testApp.sessionGuard.sweep()).resolves.toStrictEqual({ checked: 1, disconnected: 0 });
    expect(socket.connected).toBe(true);

    const disconnected = waitForDisconnect(socket);
    await testApp.redis.del(sessionKey(testApp, sessionIdOf(agent)));
    await expect(testApp.sessionGuard.sweep()).resolves.toStrictEqual({ checked: 1, disconnected: 1 });
    await expect(disconnected).resolves.toBe('io server disconnect');
    await expectServerSocketCount(testApp, user.id, 0);

    await signIn(agent, user.id);
    await connected(testApp, agent);
    await expect(testApp.sessionGuard.sweep()).resolves.toStrictEqual({ checked: 1, disconnected: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Dependency outage: fail closed
// ---------------------------------------------------------------------------------------------------------------

describe('Redis outage (F-114, F-106)', () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp.close();
  });

  it('F-114, F-106: readiness turns 503 and a signed-in handshake fails closed with a fixed message, no cause', async () => {
    const { user, agent } = await signedInAgent(testApp);
    const cookie = cookieHeaderOf(agent);
    await testApp.redis.close();

    const health = await request(testApp.app).get('/api/health');
    expect(health.status).toBe(503);

    // The session middleware on the upgrade cannot read the store: engine.io refuses the upgrade with its fixed text.
    const raw = await rawUpgrade(testApp.baseUrl, { origin: TEST_ORIGIN, cookie });
    expect(raw.status).toBe(ENGINE_BAD_REQUEST);
    expect(raw.body).toBe('Bad request');

    const error = await rejection(connectAs(agent, testApp));
    expect(error.message).toBe('websocket error');
    expect(error.data).toBeUndefined();
    expect(await serverSocketsOf(testApp, user.id)).toHaveLength(0);
  });
});
