import { buffer } from 'node:stream/consumers';

import { type AuthResponse, PROBLEM_TYPE_PREFIX, Problem, RegisterBody } from '@app/shared';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_LIMITS, type Limits } from '../src/config/limits.js';
import type { Database } from '../src/db/client.js';
import * as schema from '../src/db/schema/index.js';
import { argon2Hasher } from '../src/shared/auth/password.js';
import { createAvatarUrl, parseAvatarKey } from '../src/shared/media/media-url.js';
import { rooms } from '../src/shared/realtime/rooms.js';
import { bindAnonymousSession, CSRF_HEADER, createCsrf } from '../src/shared/security/csrf.js';
import {
  createSessionMiddleware,
  establishSession,
  sessionCookieName,
  sessionKeyPrefix,
} from '../src/shared/security/session.js';
import { currentDatabaseUrl } from './database.js';
import {
  TEST_USER_PASSWORD,
  TEST_USER_PASSWORD_HASH,
  insertChatMessages,
  insertFriendship,
  insertUser,
  insertWallPosts,
} from './db.js';
import {
  FAKE_CLOCK_START,
  FAST_HASH_PREFIX,
  createFakeClock,
  createFakeFriendshipReader,
  createFakePublisher,
  createFakeStorage,
  createFastHasher,
} from './fakes.js';
import { csrf, login, register, signIn, type TestAgent } from './http.js';
import { connectAs, recordEvents, waitFor, waitForDisconnect, type TestSocket } from './socket.js';
import { createTestApp, TEST_ORIGIN, type TestApp } from './test-app.js';
import { TEST_SIGN_IN_PATH } from './test-routes.js';

/**
 * The Phase-1b test helpers prove their own contracts here (BUILD-ORDER 1b "Test helpers", ADR-0016, ADR-0019 §3/§5),
 * so every later unit can rely on them: fakes behave like their ports, inserters write exactly what they promise in
 * one statement, `createTestApp` builds an isolated app, the sign-in route rotates the session and the CSRF token, and
 * the socket helpers connect, reject and wait deterministically. App-level behaviour (404 problem, headers, handshake
 * rules) is proven in test/app.int.test.ts and test/realtime.int.test.ts.
 */

const SESSION_COOKIE = sessionCookieName(false);

function setCookies(response: Response): string[] {
  const header: unknown = response.headers['set-cookie'];
  return Array.isArray(header) ? header.map(String) : [];
}

function cookieLine(response: Response, name: string): string | undefined {
  return setCookies(response).find((line) => line.startsWith(`${name}=`));
}

/** The session id inside the signed express-session cookie (`s:<id>.<signature>`, URL-encoded), if one was set. */
function sessionIdOf(response: Response): string | undefined {
  const line = cookieLine(response, SESSION_COOKIE);
  if (line === undefined) return undefined;
  const value = decodeURIComponent(line.slice(SESSION_COOKIE.length + 1).split(';')[0] ?? '');
  return /^s:(.+)\.[^.]+$/.exec(value)?.[1];
}

function expiresInHours(line: string | undefined): number {
  const expires = /Expires=([^;]+)/i.exec(line ?? '')?.[1];
  if (expires === undefined) throw new Error('cookie without Expires');
  return (Date.parse(expires) - Date.now()) / 3_600_000;
}

/** The `userId` of every session stored under the app's prefix (anonymous sessions have none). */
async function sessionUserIds(app: TestApp): Promise<number[]> {
  const keys = await app.redis.keys(`${sessionKeyPrefix(app.prefix)}*`);
  const values = keys.length > 0 ? await app.redis.mGet(keys) : [];
  return values.flatMap((value) => {
    const userId = value === null ? undefined : (JSON.parse(value) as { userId?: number }).userId;
    return userId === undefined ? [] : [userId];
  });
}

function problemOf(response: Response) {
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  return Problem.parse(response.body);
}

// ---------------------------------------------------------------------------------------------------------------
// Fakes (no containers involved)
// ---------------------------------------------------------------------------------------------------------------

describe('createFakeStorage', () => {
  it('stores copies: neither the caller buffer nor a read body can change the stored object', async () => {
    const storage = createFakeStorage();
    const original = Uint8Array.from([1, 2, 3]);

    await storage.put('avatars/1/a.webp', original, 'image/webp');
    original[0] = 9;
    const read = await storage.get('avatars/1/a.webp');

    expect(read.contentType).toBe('image/webp');
    expect([...(await buffer(read.body))]).toEqual([1, 2, 3]);
    expect([...storage.objects.get('avatars/1/a.webp')!.body]).toEqual([1, 2, 3]);
  });

  it('rejects a missing key with a NoSuchKey error and treats deleting it as success, like S3', async () => {
    const storage = createFakeStorage();

    await expect(storage.get('avatars/1/missing.webp')).rejects.toMatchObject({ name: 'NoSuchKey' });
    await expect(storage.delete('avatars/1/missing.webp')).resolves.toBeUndefined();
  });

  it('fails an operation until it recovers, without changing anything on the failing call', async () => {
    const storage = createFakeStorage();
    const outage = new Error('S3 unavailable');

    storage.fail('put', outage);
    await expect(storage.put('k', Uint8Array.from([1]), 'image/webp')).rejects.toBe(outage);
    await expect(storage.put('k', Uint8Array.from([1]), 'image/webp')).rejects.toBe(outage);
    expect(storage.objects.size).toBe(0);

    storage.recover('put');
    await storage.put('k', Uint8Array.from([1]), 'image/webp');
    storage.fail('delete');
    await expect(storage.delete('k')).rejects.toThrow('fake storage: delete failed');
    expect(storage.objects.has('k')).toBe(true);
    storage.recover();
    await storage.delete('k');
    expect(storage.objects.has('k')).toBe(false);
  });

  it('answers isReady from `ready`, also when the method is passed around unbound', async () => {
    const storage = createFakeStorage();
    const { isReady } = storage;

    await expect(isReady()).resolves.toBe(true);
    storage.ready = false;
    await expect(isReady()).resolves.toBe(false);
  });
});

describe('createFakePublisher', () => {
  it('records emits, room leaves and session disconnects in call order, and filters emits by event', () => {
    const publisher = createFakePublisher();

    publisher.emitToRoom(rooms.user(1), 'friendship:changed', { userId: 2, state: 'pending_incoming' });
    publisher.emitToRoom(rooms.wall(2), 'wall:post-deleted', { id: 7, wallOwnerId: 2 });
    publisher.leaveRoom(rooms.user(1), rooms.wall(2));
    publisher.disconnectSession('sid-1');

    expect(publisher.emits).toEqual([
      { room: 'user:1', event: 'friendship:changed', args: [{ userId: 2, state: 'pending_incoming' }] },
      { room: 'wall:2', event: 'wall:post-deleted', args: [{ id: 7, wallOwnerId: 2 }] },
    ]);
    const [deleted] = publisher.emitsOf('wall:post-deleted');
    expect(deleted?.args[0].wallOwnerId).toBe(2);
    expect(publisher.emitsOf('chat:message')).toEqual([]);
    expect(publisher.leaves).toEqual([{ socketsInRoom: 'user:1', room: 'wall:2' }]);
    expect(publisher.disconnectedSessions).toEqual(['sid-1']);

    publisher.clear();
    expect([publisher.emits, publisher.leaves, publisher.disconnectedSessions]).toEqual([[], [], []]);
  });
});

describe('createFakeFriendshipReader', () => {
  it('derives each side of a pending request and is symmetric once accepted', async () => {
    const reader = createFakeFriendshipReader();

    await expect(reader.stateBetween(1, 2)).resolves.toBe('none');
    reader.set(1, 2, 'pending');
    await expect(reader.stateBetween(1, 2)).resolves.toBe('pending_outgoing');
    await expect(reader.stateBetween(2, 1)).resolves.toBe('pending_incoming');
    await expect(reader.areFriends(1, 2)).resolves.toBe(false);

    reader.set(2, 1, 'accepted'); // the same pair, whichever side: one row
    await expect(reader.stateBetween(1, 2)).resolves.toBe('friends');
    await expect(reader.stateBetween(2, 1)).resolves.toBe('friends');
    await expect(reader.areFriends(2, 1)).resolves.toBe(true);

    reader.remove(1, 2);
    await expect(reader.stateBetween(2, 1)).resolves.toBe('none');
    await expect(reader.areFriends(1, 2)).resolves.toBe(false);
  });

  it('refuses a self pair like friendships_not_self_chk (B-24)', () => {
    expect(() => {
      createFakeFriendshipReader().set(3, 3, 'pending');
    }).toThrow(RangeError);
  });
});

describe('createFastHasher', () => {
  it('salts every hash and verifies only the right password', async () => {
    const hasher = createFastHasher();
    const first = await hasher.hash('a long enough password');
    const second = await hasher.hash('a long enough password');

    expect(first).not.toBe(second);
    expect(first.startsWith(FAST_HASH_PREFIX)).toBe(true);
    await expect(hasher.verify(first, 'a long enough password')).resolves.toBe(true);
    await expect(hasher.verify(first, 'a long enough passwore')).resolves.toBe(false);
    expect(hasher.needsRehash(first)).toBe(false);
  });

  it('answers false for a malformed or foreign hash instead of throwing, and wants a foreign hash rehashed', async () => {
    const hasher = createFastHasher();

    await expect(hasher.verify('$fast$broken', 'x')).resolves.toBe(false);
    await expect(hasher.verify('$fast$aa$00', 'x')).resolves.toBe(false);
    await expect(hasher.verify(TEST_USER_PASSWORD_HASH, TEST_USER_PASSWORD)).resolves.toBe(false);
    expect(hasher.needsRehash(TEST_USER_PASSWORD_HASH)).toBe(true);
  });
});

describe('createFakeClock', () => {
  it('starts at a fixed instant, moves only when told and hands out copies', () => {
    const clock = createFakeClock();
    const now = clock.now();

    expect(now.toISOString()).toBe(FAKE_CLOCK_START.toISOString());
    now.setFullYear(2000);
    expect(clock.now().toISOString()).toBe(FAKE_CLOCK_START.toISOString());

    expect(clock.advance(1_500).toISOString()).toBe('2026-01-15T09:00:01.500Z');
    expect(clock.nowMs()).toBe(FAKE_CLOCK_START.getTime() + 1_500);
    expect(() => clock.advance(-1)).toThrow(RangeError);

    clock.set(new Date('2025-12-31T23:59:59.999Z'));
    expect(clock.now().toISOString()).toBe('2025-12-31T23:59:59.999Z');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Inserters (the file's own database)
// ---------------------------------------------------------------------------------------------------------------

describe('test/db.ts inserters', () => {
  let pool: Pool;
  let db: Database;
  let statements: string[];

  beforeAll(() => {
    pool = new Pool({ connectionString: currentDatabaseUrl(), max: 2 });
    db = drizzle({
      client: pool,
      schema,
      logger: {
        logQuery: (sql) => {
          statements.push(sql);
        },
      },
    });
  });

  beforeEach(() => {
    statements = [];
  });

  afterAll(async () => {
    await pool.end();
  });

  it('B-16: the precomputed hash is a real argon2id hash of the test password with the pinned parameters', async () => {
    expect(TEST_USER_PASSWORD_HASH).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    await expect(argon2Hasher.verify(TEST_USER_PASSWORD_HASH, TEST_USER_PASSWORD)).resolves.toBe(true);
    expect(argon2Hasher.needsRehash(TEST_USER_PASSWORD_HASH)).toBe(false);
  });

  it('insertUser writes one row with unique defaults and the precomputed hash', async () => {
    const first = await insertUser(db);
    const second = await insertUser(db);

    expect(statements).toHaveLength(2);
    expect(first.email).toMatch(/^[0-9a-f-]{36}@example\.com$/);
    expect(second.email).not.toBe(first.email);
    expect(second.lastName).not.toBe(first.lastName);
    expect(first).toMatchObject({ firstName: 'Test', bio: null, avatarKey: null });
    expect(first.passwordHash).toBe(TEST_USER_PASSWORD_HASH);
  });

  it('insertUser takes explicit fields and a createdAt that also becomes updatedAt', async () => {
    const createdAt = new Date('2024-03-01T12:00:00.123Z');
    const user = await insertUser(db, { firstName: 'Mira', lastName: 'Novak', bio: 'Hello', createdAt });

    expect(user).toMatchObject({ firstName: 'Mira', lastName: 'Novak', bio: 'Hello' });
    expect(user.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(user.updatedAt.toISOString()).toBe(createdAt.toISOString());
  });

  it("insertUser({ avatar: true }) stores a server-made key of the user's own id, so the avatar URL builds", async () => {
    const createdAt = new Date('2024-03-01T12:00:00.123Z');
    const user = await insertUser(db, { avatar: true, createdAt });

    expect(parseAvatarKey(user.avatarKey ?? '')).toEqual({ userId: user.id, version: expect.any(String) as string });
    expect(createAvatarUrl()(user.id, user.avatarKey)).toMatch(
      new RegExp(`^/api/users/${String(user.id)}/avatar\\?v=`),
    );
    expect(user.updatedAt.toISOString()).toBe(createdAt.toISOString());
  });

  it('insertFriendship stores the direction and acceptedAt, and the pair index refuses a reverse duplicate', async () => {
    const [mira, jonas, lea] = [await insertUser(db), await insertUser(db), await insertUser(db)];
    const createdAt = new Date('2024-05-01T08:00:00.000Z');

    const pending = await insertFriendship(db, mira.id, jonas.id, 'pending', { createdAt });
    const accepted = await insertFriendship(db, lea.id, mira.id, 'accepted', { createdAt });

    expect(pending).toMatchObject({ requesterId: mira.id, addresseeId: jonas.id, status: 'pending', acceptedAt: null });
    expect(pending.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(accepted.acceptedAt?.toISOString()).toBe(createdAt.toISOString());
    await expect(insertFriendship(db, jonas.id, mira.id, 'pending')).rejects.toThrow();
    await expect(insertFriendship(db, mira.id, mira.id, 'pending')).rejects.toThrow();
    await expect(insertFriendship(db, jonas.id, lea.id, 'pending', { acceptedAt: new Date() })).rejects.toThrow(
      RangeError,
    );
  });

  it('insertWallPosts writes n posts in one statement, in id order, with per-row timestamps', async () => {
    const [owner, author] = [await insertUser(db), await insertUser(db)];
    const base = Date.parse('2024-06-01T00:00:00.000Z');
    statements = [];

    const posts = await insertWallPosts(db, owner.id, author.id, 25, {
      createdAt: (index) => new Date(base + index * 1_000),
    });

    expect(statements).toHaveLength(1);
    expect(posts).toHaveLength(25);
    expect(posts.map((post) => post.id)).toEqual([...posts.map((post) => post.id)].sort((a, b) => a - b));
    expect(posts[0]).toMatchObject({ wallOwnerId: owner.id, authorId: author.id, body: 'Post 1' });
    expect(posts[24]?.body).toBe('Post 25');
    expect(posts[24]?.createdAt.toISOString()).toBe('2024-06-01T00:00:24.000Z');
  });

  it('insertWallPosts can put every row on the same millisecond (keyset ties) and refuses a count below 1', async () => {
    const owner = await insertUser(db);
    const at = new Date('2024-06-02T10:00:00.555Z');

    const posts = await insertWallPosts(db, owner.id, owner.id, 3, { createdAt: at, body: (i) => `Tie ${String(i)}` });

    expect(new Set(posts.map((post) => post.createdAt.toISOString()))).toEqual(new Set([at.toISOString()]));
    expect(posts.map((post) => post.body)).toEqual(['Tie 0', 'Tie 1', 'Tie 2']);
    await expect(insertWallPosts(db, owner.id, owner.id, 0)).rejects.toThrow(RangeError);
  });

  it('insertChatMessages writes n messages in one statement with the given timestamp', async () => {
    const author = await insertUser(db);
    const at = new Date('2024-07-01T18:30:00.250Z');
    statements = [];

    const messages = await insertChatMessages(db, author.id, 25, { createdAt: at });

    expect(statements).toHaveLength(1);
    expect(messages).toHaveLength(25);
    expect(messages[0]).toMatchObject({ authorId: author.id, body: 'Message 1' });
    expect(messages.every((message) => message.createdAt.toISOString() === at.toISOString())).toBe(true);
    await expect(insertChatMessages(db, author.id, 1.5)).rejects.toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// createTestApp, the sign-in route and the agent helpers
// ---------------------------------------------------------------------------------------------------------------

describe('createTestApp', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('listens on an ephemeral loopback port with its own test-<uuid> key prefix', async () => {
    expect(testApp.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(testApp.prefix).toMatch(/^test-[0-9a-f-]{36}$/);

    const response = await request(testApp.baseUrl).get('/health/live');
    expect(response.status).toBe(200);
  });

  it('raises every limit by the test multiplier (100) by default', async () => {
    const response = await request(testApp.app).get('/api/csrf-token');

    expect(response.headers['ratelimit']).toMatch(/^"global"; r=\d+; t=\d+$/);
    // draft-8 policy: quota and window, then the partition key (`pk`, a hash of the limiter key).
    expect(response.headers['ratelimit-policy']).toMatch(
      new RegExp(
        `^"global"; q=${String(DEFAULT_LIMITS.global.limit * 100)}; w=${String(DEFAULT_LIMITS.global.windowMs / 1000)}; pk=:[^:]+:$`,
      ),
    );
  });

  it('keeps sessions in Redis under its own prefix', async () => {
    const user = await insertUser(testApp.db);
    const agent = request.agent(testApp.app);

    await signIn(agent, user.id);

    expect(await sessionUserIds(testApp)).toContain(user.id);
  });

  it('validates env overrides with the real schema', async () => {
    await expect(createTestApp({ env: { PRESENCE_GRACE_MS: '-1' } })).rejects.toThrow(/PRESENCE_GRACE_MS/);
  });

  it('takes exact limits, e.g. a global limit of 2 per window', async () => {
    const limits: Limits = { ...DEFAULT_LIMITS, global: { limit: 2, windowMs: 60_000 } };
    const strict = await createTestApp({ limits, keyPrefix: `${testApp.prefix}-strict` });
    try {
      expect(strict.prefix).toBe(`${testApp.prefix}-strict`);
      const agent = request.agent(strict.app);
      expect((await agent.get('/api/csrf-token')).status).toBe(200);
      expect((await agent.get('/api/csrf-token')).status).toBe(200);

      const limited = await agent.get('/api/csrf-token');
      expect(limited.status).toBe(429);
      expect(problemOf(limited).type).toBe(`${PROBLEM_TYPE_PREFIX}rate-limited`);
    } finally {
      await strict.close();
    }
  });

  it('close() is idempotent and stops the HTTP server', async () => {
    const other = await createTestApp();

    await Promise.all([other.close(), other.close()]);

    expect(other.httpServer.listening).toBe(false);
    expect(other.redis.isOpen).toBe(false);
  });

  it('without test routes answers POST /__test/sign-in with the 404 problem (ADR-0019 §3)', async () => {
    const production = await createTestApp({ testRoutes: false });
    try {
      const user = await insertUser(production.db);
      const agent = request.agent(production.app);
      // With a valid token, so the request gets past CSRF protection (which answers 403 to any tokenless POST) and
      // shows that no route handles the path.
      await csrf(agent);

      const response = await agent.post(TEST_SIGN_IN_PATH).send({ userId: user.id });

      expect(response.status).toBe(404);
      expect(problemOf(response).type).toBe(`${PROBLEM_TYPE_PREFIX}not-found`);
      expect(await sessionUserIds(production)).not.toContain(user.id);
    } finally {
      await production.close();
    }
  });
});

describe('POST /__test/sign-in and test/http.ts', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-18, B-58: signIn regenerates the session id and returns a token that only the new session accepts', async () => {
    const user = await insertUser(testApp.db);
    const agent = request.agent(testApp.app);
    const anonymous = await agent.get('/api/csrf-token');
    const anonymousToken = (anonymous.body as { token: string }).token;
    const anonymousId = sessionIdOf(anonymous);
    expect(anonymousId).toBeDefined();

    const signedIn = await agent.post(TEST_SIGN_IN_PATH).send({ userId: user.id });

    expect(signedIn.status).toBe(200);
    const signedInId = sessionIdOf(signedIn);
    expect(signedInId).toBeDefined();
    expect(signedInId).not.toBe(anonymousId);
    const { csrfToken } = signedIn.body as { csrfToken: string };
    expect(csrfToken).not.toBe(anonymousToken);
    expect(await testApp.redis.exists(`${sessionKeyPrefix(testApp.prefix)}${anonymousId!}`)).toBe(0);

    // A mutation reaches routing (404: no such route yet) only with the new token; the old one is bound to the old id.
    const stale = await agent.post('/api/helper-probe').set(CSRF_HEADER, anonymousToken).send({});
    expect(stale.status).toBe(403);
    expect(problemOf(stale).type).toBe(`${PROBLEM_TYPE_PREFIX}csrf-invalid`);
    const fresh = await agent.post('/api/helper-probe').set(CSRF_HEADER, csrfToken).send({});
    expect(fresh.status).toBe(404);
  });

  it('signIn starts a normal-TTL session (7 days), not the 2 h anonymous one', async () => {
    const user = await insertUser(testApp.db);

    const response = await request(testApp.app).post(TEST_SIGN_IN_PATH).send({ userId: user.id });

    const hours = expiresInHours(cookieLine(response, SESSION_COOKIE));
    expect(hours).toBeGreaterThan(7 * 24 - 1);
    expect(hours).toBeLessThanOrEqual(7 * 24);
  });

  it('signIn stores the token on the agent, so mutations pass CSRF until the header is unset', async () => {
    const user = await insertUser(testApp.db);
    const agent = request.agent(testApp.app);

    const token = await signIn(agent, user.id);

    expect(token.length).toBeGreaterThan(0);
    expect((await agent.post('/api/helper-probe').send({})).status).toBe(404);
    const missing = await agent.post('/api/helper-probe').unset(CSRF_HEADER).send({});
    expect(missing.status).toBe(403);
    expect(problemOf(missing).type).toBe(`${PROBLEM_TYPE_PREFIX}csrf-invalid`);
  });

  it('csrf() binds an anonymous session and stores its token', async () => {
    const agent = request.agent(testApp.app);

    const token = await csrf(agent);

    expect(token.length).toBeGreaterThan(0);
    expect((await agent.delete('/api/helper-probe')).status).toBe(404);
  });

  it('answers the 404 problem for an unknown user and creates no session', async () => {
    const response = await request(testApp.app).post(TEST_SIGN_IN_PATH).send({ userId: 2_147_483_647 });

    expect(response.status).toBe(404);
    expect(problemOf(response)).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}not-found`, instance: TEST_SIGN_IN_PATH });
    expect(sessionIdOf(response)).toBeUndefined();
    await expect(signIn(request.agent(testApp.app), 2_147_483_647)).rejects.toThrow(/expected HTTP 200, got 404/);
  });

  it('answers 422 validation-failed for a body that is not exactly { userId: <Id> }', async () => {
    const user = await insertUser(testApp.db);

    for (const body of [{}, { userId: String(user.id) }, { userId: 0 }, { userId: user.id, admin: true }]) {
      const response = await request(testApp.app).post(TEST_SIGN_IN_PATH).send(body);

      expect(response.status).toBe(422);
      expect(problemOf(response).type).toBe(`${PROBLEM_TYPE_PREFIX}validation-failed`);
      expect(sessionIdOf(response)).toBeUndefined();
    }
  });
});

/**
 * `register()`/`login()` target the auth unit's routes, which are stubs in Phase 1b. A stand-in with the documented
 * contract (API.md: register 201 / login 200 `AuthResponse`, CSRF-protected, session regenerated) and the real shared
 * session and CSRF pieces proves the helpers' side: token first, the right body, the rotated token stored.
 */
describe('register() and login() against a stand-in with the auth contract', () => {
  let testApp: TestApp;
  let standIn: Express;
  const accounts = new Map<string, { id: number; password: string }>();

  beforeAll(async () => {
    testApp = await createTestApp();
    const prefix = `${testApp.prefix}-auth`;
    const csrfUtilities = createCsrf({ secret: 'stand-in-csrf-secret-with-32-characters!', secure: false });
    standIn = express();
    standIn.use(express.json());
    standIn.use(
      createSessionMiddleware({
        redis: testApp.redis,
        secret: 'stand-in-session-secret-32-chars!!',
        secure: false,
        prefix,
        ttlDays: 7,
      }),
    );
    standIn.use(cookieParser());
    standIn.get('/api/csrf-token', (req, res) => {
      bindAnonymousSession(req);
      res.json({ token: csrfUtilities.generateCsrfToken(req, res) });
    });
    standIn.use(csrfUtilities.doubleCsrfProtection);
    const answer = async (req: express.Request, res: express.Response, status: number, id: number) => {
      await establishSession(req, id);
      const csrfToken = csrfUtilities.generateCsrfToken(req, res, { overwrite: true });
      const body: AuthResponse = {
        user: { id, firstName: 'Test', lastName: 'User', avatarUrl: null, bio: null },
        csrfToken,
      };
      res.status(status).json(body);
    };
    standIn.post('/api/auth/register', async (req, res) => {
      const body = RegisterBody.parse(req.body);
      const id = accounts.size + 1;
      accounts.set(body.email, { id, password: body.password });
      await answer(req, res, 201, id);
    });
    standIn.post('/api/auth/login', async (req, res) => {
      const { email, password } = req.body as { email: string; password: string };
      const account = accounts.get(email);
      if (account?.password !== password) {
        res.status(401).json({ title: 'Unauthorized' });
        return;
      }
      await answer(req, res, 200, account.id);
    });
    standIn.post('/api/probe', (_req, res) => {
      res.status(204).end();
    });
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('register() sends a valid unique body with a CSRF token and stores the rotated token', async () => {
    const agent: TestAgent = request.agent(standIn);

    const first = await register(agent);
    const second = await register(request.agent(standIn), { firstName: 'Mira' });

    expect(first.response.status).toBe(201);
    expect(first.email).toMatch(/^[0-9a-f-]{36}@example\.com$/);
    expect(second.email).not.toBe(first.email);
    expect(first.password.length).toBeGreaterThanOrEqual(12);
    expect(first.user.id).toBe(accounts.get(first.email)?.id);
    expect((await agent.post('/api/probe')).status).toBe(204);
  });

  it('login() logs in with the returned credentials and stores the new token; a failure names the status', async () => {
    const { email, password } = await register(request.agent(standIn));
    const agent = request.agent(standIn);

    const result = await login(agent, { email, password });

    expect(result.response.status).toBe(200);
    expect(result.user.id).toBe(accounts.get(email)?.id);
    expect((await agent.post('/api/probe')).status).toBe(204);
    await expect(login(request.agent(standIn), { email, password: 'wrong password!' })).rejects.toThrow(
      /POST \/api\/auth\/login: expected HTTP 200, got 401/,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Socket helpers
// ---------------------------------------------------------------------------------------------------------------

describe('test/socket.ts', () => {
  let testApp: TestApp;
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  afterAll(async () => {
    await testApp.close();
  });

  async function signedInSocket(): Promise<{ userId: number; agent: TestAgent; socket: TestSocket }> {
    const user = await insertUser(testApp.db);
    const agent = request.agent(testApp.app);
    await signIn(agent, user.id);
    const socket = await connectAs(agent, testApp);
    sockets.push(socket);
    return { userId: user.id, agent, socket };
  }

  it('connectAs connects a signed-in agent over WebSocket as that user', async () => {
    const { userId, socket } = await signedInSocket();

    expect(socket.connected).toBe(true);
    expect(socket.io.engine.transport.name).toBe('websocket');
    const [server] = await testApp.io.in(rooms.user(userId)).fetchSockets();
    expect(server?.data.user.id).toBe(userId);
    expect(server?.handshake.headers.origin).toBe(TEST_ORIGIN);
  });

  it('connectAs rejects with the handshake error for an anonymous agent', async () => {
    await expect(connectAs(request.agent(testApp.app), testApp)).rejects.toThrow('unauthorized');
  });

  it('connectAs sends a foreign origin or none at all when asked, and the handshake refuses both (B-07, B-38)', async () => {
    const user = await insertUser(testApp.db);
    const agent = request.agent(testApp.app);
    await signIn(agent, user.id);

    await expect(connectAs(agent, { baseUrl: testApp.baseUrl, origin: 'https://evil.example' })).rejects.toThrow();
    await expect(connectAs(agent, { baseUrl: testApp.baseUrl, origin: null })).rejects.toThrow();
    expect(await testApp.io.in(rooms.user(user.id)).fetchSockets()).toHaveLength(0);
  });

  it('waitFor resolves with the first payload that passes the filter', async () => {
    const { userId, socket } = await signedInSocket();
    const left = waitFor(socket, 'presence:left', { filter: ({ userId: id }) => id === 42 });

    testApp.io.to(rooms.user(userId)).emit('presence:left', { userId: 41 });
    testApp.io.to(rooms.user(userId)).emit('presence:left', { userId: 42 });

    await expect(left).resolves.toEqual({ userId: 42 });
  });

  it('waitFor rejects after its timeout with the missing event in the message', async () => {
    const { socket } = await signedInSocket();

    await expect(waitFor(socket, 'chat:message', { timeoutMs: 50 })).rejects.toThrow(
      "waitFor: no 'chat:message' within 50 ms",
    );
  });

  it('recordEvents collects only its event, ordered by a real delivery', async () => {
    const { userId, socket } = await signedInSocket();
    const received = recordEvents(socket, 'presence:joined');
    const marker = waitFor(socket, 'presence:left');

    testApp.io
      .to(rooms.user(userId))
      .emit('presence:joined', { id: 5, firstName: 'A', lastName: 'B', avatarUrl: null });
    testApp.io.to(rooms.user(userId)).emit('presence:left', { userId: 5 });
    await marker;

    expect(received).toEqual([{ id: 5, firstName: 'A', lastName: 'B', avatarUrl: null }]);
  });

  it('waitForDisconnect reports the server closing the socket after its session ended (sessionGuard.sweep)', async () => {
    const { socket } = await signedInSocket();
    const disconnected = waitForDisconnect(socket);

    await testApp.redis.del(await testApp.redis.keys(`${sessionKeyPrefix(testApp.prefix)}*`));
    const result = await testApp.sessionGuard.sweep();

    expect(result.disconnected).toBeGreaterThanOrEqual(1);
    await expect(disconnected).resolves.toBe('io server disconnect');
  });

  it("close() disconnects the app's open sockets", async () => {
    const other = await createTestApp();
    const user = await insertUser(other.db);
    const agent = request.agent(other.app);
    await signIn(agent, user.id);
    const socket = await connectAs(agent, other);
    sockets.push(socket);
    const disconnected = waitForDisconnect(socket);

    await other.close();

    await expect(disconnected).resolves.toBe('transport close');
  });
});
