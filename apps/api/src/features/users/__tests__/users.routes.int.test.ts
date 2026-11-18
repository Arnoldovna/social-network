import { randomUUID } from 'node:crypto';

import {
  BIO_MAX,
  CHAT_MAX,
  EMAIL_MAX,
  MeResponse,
  NAME_MAX,
  POST_MAX,
  PROBLEM_TYPE_PREFIX,
  Problem,
  type ProblemCode,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SearchResponse,
  UserProfileResponse,
} from '@app/shared';
import { count, eq, inArray, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { currentDatabaseUrl } from '../../../../test/database.js';
import {
  insertChatMessages,
  insertFriendship,
  insertUser,
  insertWallPosts,
  type InsertUserFields,
  type UserRow,
} from '../../../../test/db.js';
import { csrf, signIn, type TestAgent } from '../../../../test/http.js';
import { createTestApp, TEST_RATE_LIMIT_MULTIPLIER, type TestApp } from '../../../../test/test-app.js';
import { resolveLimits } from '../../../config/limits.js';
import * as schema from '../../../db/schema/index.js';
import { parseAvatarKey } from '../../../shared/media/media-url.js';
import { prefixPattern } from '../search-pattern.js';
import { createUsersRepository } from '../users.repository.js';

/**
 * The users routes on the real app, Postgres and Redis (API.md "Profile and users"): `GET/PATCH /api/me`,
 * `GET /api/users/:id`, `GET /api/users/search`. Every success body is parsed with the strict shared schema (B-19);
 * every error is asserted as RFC 9457 problem+json with its code. Users come from `insertUser`, sessions from
 * `signIn`, friendships from `insertFriendship` (BUILD-ORDER Phase 2).
 */

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

/** Anything that would show a stack trace, a source path or an HTML page in a response body. */
const LEAK = /<html|<!doctype|\bstack\b|at \w+ \(|node_modules|\.ts:\d+|\/src\//i;

function expectProblem(response: Response, status: number, code: ProblemCode): Problem {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  const problem = Problem.parse(response.body);
  expect(problem).toMatchObject({ status, type: `${PROBLEM_TYPE_PREFIX}${code}` });
  // F-113: the instance never carries the query string (search terms stay out of problems and logs).
  expect(problem.instance).toMatch(/^\/[^?#]*$/);
  expect(response.text).not.toMatch(LEAK);
  return problem;
}

/** A user from `insertUser`, signed in on a fresh agent that carries the session cookie and the CSRF token. */
async function signedIn(fields: InsertUserFields = {}): Promise<{ agent: TestAgent; user: UserRow }> {
  const user = await insertUser(testApp.db, fields);
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  return { agent, user };
}

/** A per-test prefix of hex characters, so a search only ever finds the test's own users. */
function uniqueTag(): string {
  return `q${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

/** B-19, F-43: none of the private columns of `row` appears anywhere in the body. */
function expectNoPrivateFields(response: Response, row: UserRow): void {
  expect(response.text).not.toContain(row.email);
  expect(response.text).not.toContain(row.passwordHash);
  expect(response.text).not.toMatch(/"(email|passwordHash|password_hash|createdAt|updatedAt|avatarKey)"/);
  if (row.avatarKey) expect(response.text).not.toContain(row.avatarKey);
}

async function storedBio(userId: number): Promise<string | null | undefined> {
  const [row] = await testApp.db
    .select({ bio: schema.users.bio })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row?.bio;
}

describe('GET /api/me', () => {
  it('F-21: returns the public fields of the signed-in user', async () => {
    const { agent, user } = await signedIn({ firstName: 'Ada', lastName: 'Lovelace', bio: 'Engines.' });

    const response = await agent.get('/api/me').expect(200);

    expect(MeResponse.parse(response.body)).toEqual({
      user: { id: user.id, firstName: 'Ada', lastName: 'Lovelace', bio: 'Engines.', avatarUrl: null },
    });
    expectNoPrivateFields(response, user);
  });

  it('serves the avatar as the stable per-user URL, never as the object key', async () => {
    const { agent, user } = await signedIn({ avatar: true });
    const version = parseAvatarKey(user.avatarKey ?? '')?.version;

    const response = await agent.get('/api/me').expect(200);

    expect(MeResponse.parse(response.body).user.avatarUrl).toBe(
      `/api/users/${String(user.id)}/avatar?v=${String(version)}`,
    );
    expectNoPrivateFields(response, user);
  });

  it('answers a visitor with 401 unauthorized', async () => {
    expectProblem(await request(testApp.app).get('/api/me'), 401, 'unauthorized');
  });
});

describe('PATCH /api/me', () => {
  it('F-29: trims the bio, stores it and returns the updated profile', async () => {
    const { agent, user } = await signedIn();

    const response = await agent.patch('/api/me').send({ bio: '  Writes compilers.\nAnd poems.  ' }).expect(200);

    expect(MeResponse.parse(response.body).user).toMatchObject({ id: user.id, bio: 'Writes compilers.\nAnd poems.' });
    expect(await storedBio(user.id)).toBe('Writes compilers.\nAnd poems.');
    expect(MeResponse.parse((await agent.get('/api/me').expect(200)).body).user.bio).toBe(
      'Writes compilers.\nAnd poems.',
    );
  });

  it(`F-29: accepts exactly ${String(BIO_MAX)} characters after trimming`, async () => {
    const { agent, user } = await signedIn();
    const bio = 'b'.repeat(BIO_MAX);

    await agent
      .patch('/api/me')
      .send({ bio: `   ${bio}   ` })
      .expect(200);

    expect(await storedBio(user.id)).toBe(bio);
  });

  it(`F-29, B-56: rejects more than ${String(BIO_MAX)} characters with 422 and stores nothing`, async () => {
    const { agent, user } = await signedIn({ bio: 'Before.' });

    const response = await agent.patch('/api/me').send({ bio: 'b'.repeat(BIO_MAX + 1) });

    const problem = expectProblem(response, 422, 'validation-failed');
    expect(problem.errors).toEqual([
      { location: 'body', path: 'bio', message: 'Keep your bio under 1,000 characters.' },
    ]);
    expect(await storedBio(user.id)).toBe('Before.');
  });

  it('F-28: saving the unchanged bio keeps it', async () => {
    const { agent, user } = await signedIn({ bio: 'Unchanged.' });

    const response = await agent.patch('/api/me').send({ bio: 'Unchanged.' }).expect(200);

    expect(MeResponse.parse(response.body).user.bio).toBe('Unchanged.');
    expect(await storedBio(user.id)).toBe('Unchanged.');
  });

  it.each([
    { name: 'null', bio: null },
    { name: 'an empty string', bio: '' },
    { name: 'only whitespace', bio: ' \n\t ' },
  ])('F-28, B-76: an explicit $name clears the bio to null (never an empty string)', async ({ bio }) => {
    const { agent, user } = await signedIn({ bio: 'To be removed.' });

    const response = await agent.patch('/api/me').send({ bio }).expect(200);

    expect(MeResponse.parse(response.body).user.bio).toBeNull();
    expect(await storedBio(user.id)).toBeNull();
  });

  it.each([
    { name: 'a missing bio key', body: {} },
    { name: 'a number', body: { bio: 0 } },
    { name: 'false', body: { bio: false } },
    { name: 'an array', body: { bio: ['x'] } },
  ])('B-76: $name is 422, never coerced to NULL', async ({ body }) => {
    const { agent, user } = await signedIn({ bio: 'Kept.' });

    const problem = expectProblem(await agent.patch('/api/me').send(body), 422, 'validation-failed');

    expect(problem.errors?.[0]).toMatchObject({ location: 'body', path: 'bio' });
    expect(await storedBio(user.id)).toBe('Kept.');
  });

  it('changes only the bio: other keys in the body are ignored', async () => {
    const { agent, user } = await signedIn({ firstName: 'Ada', lastName: 'Lovelace' });
    const other = await insertUser(testApp.db, { bio: 'Not yours.' });

    const response = await agent
      .patch('/api/me')
      .send({ bio: 'Mine.', id: other.id, firstName: 'Mallory', email: 'mallory@example.com', avatarKey: 'x' })
      .expect(200);

    expect(MeResponse.parse(response.body).user).toEqual({
      id: user.id,
      firstName: 'Ada',
      lastName: 'Lovelace',
      bio: 'Mine.',
      avatarUrl: null,
    });
    const [stored] = await testApp.db.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(stored).toMatchObject({ firstName: 'Ada', email: user.email, avatarKey: null });
    expect(await storedBio(other.id)).toBe('Not yours.');
  });

  it('B-56: answers a visitor with 401 even with a valid CSRF token', async () => {
    const agent = request.agent(testApp.app);
    await csrf(agent);

    expectProblem(await agent.patch('/api/me').send({ bio: 'Anonymous.' }), 401, 'unauthorized');
  });

  it('F-23, B-56: rejects a signed-in request without the CSRF token with 403 and stores nothing', async () => {
    const { agent, user } = await signedIn({ bio: 'Before.' });

    const response = await agent.patch('/api/me').unset('x-csrf-token').send({ bio: 'Forged.' });

    expectProblem(response, 403, 'csrf-invalid');
    expect(await storedBio(user.id)).toBe('Before.');
  });

  it('F-23: rejects a CSRF token issued for another session', async () => {
    const { agent, user } = await signedIn({ bio: 'Before.' });
    const attacker = request.agent(testApp.app);
    const foreignToken = await csrf(attacker);

    const response = await agent.patch('/api/me').set('x-csrf-token', foreignToken).send({ bio: 'Forged.' });

    expectProblem(response, 403, 'csrf-invalid');
    expect(await storedBio(user.id)).toBe('Before.');
  });
});

describe('GET /api/users/:id', () => {
  it('F-40, F-43, B-78: shows another user with their bio and public fields only', async () => {
    const { agent, user: me } = await signedIn();
    const them = await insertUser(testApp.db, {
      firstName: 'Grace',
      lastName: 'Hopper',
      bio: 'Compilers.',
      avatar: true,
    });

    const response = await agent.get(`/api/users/${String(them.id)}`).expect(200);

    const body = UserProfileResponse.parse(response.body);
    expect(body.user).toEqual({
      id: them.id,
      firstName: 'Grace',
      lastName: 'Hopper',
      bio: 'Compilers.',
      avatarUrl: `/api/users/${String(them.id)}/avatar?v=${String(parseAvatarKey(them.avatarKey ?? '')?.version)}`,
    });
    expect(body.relationship).toEqual({ state: 'none', canViewWall: false, canPostOnWall: false });
    expectNoPrivateFields(response, them);
    expectNoPrivateFields(response, me);
  });

  it('F-40: a user without a bio has bio null', async () => {
    const { agent } = await signedIn();
    const them = await insertUser(testApp.db, { bio: null });

    const response = await agent.get(`/api/users/${String(them.id)}`).expect(200);

    expect(UserProfileResponse.parse(response.body).user.bio).toBeNull();
  });

  it('F-41: the own id answers state "self" with both wall flags', async () => {
    const { agent, user } = await signedIn();

    const response = await agent.get(`/api/users/${String(user.id)}`).expect(200);

    expect(UserProfileResponse.parse(response.body).relationship).toEqual({
      state: 'self',
      canViewWall: true,
      canPostOnWall: true,
    });
  });

  it.each([
    { name: 'a request I sent', from: 'me', status: 'pending', state: 'pending_outgoing', allowed: false },
    { name: 'a request I received', from: 'them', status: 'pending', state: 'pending_incoming', allowed: false },
    { name: 'a friendship I asked for', from: 'me', status: 'accepted', state: 'friends', allowed: true },
    { name: 'a friendship they asked for', from: 'them', status: 'accepted', state: 'friends', allowed: true },
  ] as const)('F-45, F-65, F-66: $name → $state, wall flags $allowed', async ({ from, status, state, allowed }) => {
    const { agent, user: me } = await signedIn();
    const them = await insertUser(testApp.db);
    const [requester, addressee] = from === 'me' ? [me.id, them.id] : [them.id, me.id];
    await insertFriendship(testApp.db, requester, addressee, status);

    const response = await agent.get(`/api/users/${String(them.id)}`).expect(200);

    expect(UserProfileResponse.parse(response.body).relationship).toEqual({
      state,
      canViewWall: allowed,
      canPostOnWall: allowed,
    });
  });

  it('F-45: reflects the friendship as it is now, without caching', async () => {
    const { agent, user: me } = await signedIn();
    const them = await insertUser(testApp.db);
    const path = `/api/users/${String(them.id)}`;

    expect(UserProfileResponse.parse((await agent.get(path).expect(200)).body).relationship.state).toBe('none');
    await insertFriendship(testApp.db, them.id, me.id, 'accepted');
    expect(UserProfileResponse.parse((await agent.get(path).expect(200)).body).relationship.state).toBe('friends');
  });

  it('F-42, B-55: a well-formed id of nobody is 404 user-not-found', async () => {
    const { agent } = await signedIn();

    const problem = expectProblem(await agent.get('/api/users/2147483647'), 404, 'user-not-found');

    expect(problem.detail).toBe('This user does not exist.');
  });

  it.each(['abc', '0', '07', '-1', '1.5', '1e3', '0x1F', '%207', '7%20', '2147483648', '99999999999'])(
    'F-42, B-55: the malformed id "%s" is 400 invalid-request, never a database error',
    async (id) => {
      const { agent } = await signedIn();

      const problem = expectProblem(await agent.get(`/api/users/${id}`), 400, 'invalid-request');

      expect(problem.errors?.[0]).toMatchObject({ location: 'params', path: 'id' });
    },
  );

  it('answers a visitor with 401 unauthorized', async () => {
    const them = await insertUser(testApp.db);
    expectProblem(await request(testApp.app).get(`/api/users/${String(them.id)}`), 401, 'unauthorized');
  });
});

describe('GET /api/users/search', () => {
  /** Inserts users whose names start with `tag`, so only this test's users can match. */
  async function people(tag: string) {
    const insert = (firstName: string, lastName: string) => insertUser(testApp.db, { firstName, lastName });
    return {
      adaLovelace: await insert(`${tag}Ada`, 'Lovelace'),
      adamSmith: await insert(`${tag}Adam`, 'Smith'),
      graceHopper: await insert('Grace', `${tag}Hopper`),
      bob: await insert(`${tag}Bob`, 'Builder'),
    };
  }

  async function search(agent: TestAgent, query: Record<string, string>): Promise<number[]> {
    const response = await agent.get('/api/users/search').query(query).expect(200);
    return SearchResponse.parse(response.body).items.map((item) => item.id);
  }

  it('F-60, F-64: prefix match on first, last or full name, case-insensitive, over HTTP', async () => {
    const tag = uniqueTag();
    const { agent } = await signedIn();
    const p = await people(tag);

    // Ordered by first name: "Grace" (matched by her last name) sorts before the tag-prefixed first names.
    expect(await search(agent, { q: tag.toUpperCase() })).toEqual([
      p.graceHopper.id,
      p.adaLovelace.id,
      p.adamSmith.id,
      p.bob.id,
    ]);
    expect(await search(agent, { q: `${tag}ada` })).toEqual([p.adaLovelace.id, p.adamSmith.id]);
    expect(await search(agent, { q: `${tag}HOP` })).toEqual([p.graceHopper.id]);
    expect(await search(agent, { q: `${tag}Ada Lov` })).toEqual([p.adaLovelace.id]);
    expect(await search(agent, { q: `grace ${tag}hopper` })).toEqual([p.graceHopper.id]);
    expect(await search(agent, { q: `   ${tag}bob   ` })).toEqual([p.bob.id]);
    // Prefix, not substring: the tag is inside every name but at the start of no word after the first.
    expect(await search(agent, { q: tag.slice(1) })).toEqual([]);
  });

  it('F-61, B-49: returns all matches ordered by name, excluding the searcher', async () => {
    const tag = uniqueTag();
    const { agent, user: me } = await signedIn({ firstName: `${tag}Aaron`, lastName: 'Me' });
    const zed = await insertUser(testApp.db, { firstName: `${tag}zed`, lastName: 'Last' });
    const anna = await insertUser(testApp.db, { firstName: `${tag}Anna`, lastName: 'Bell' });
    const annaFirst = await insertUser(testApp.db, { firstName: `${tag}anna`, lastName: 'Able' });
    const twin = await insertUser(testApp.db, { firstName: `${tag}Anna`, lastName: 'Bell' });

    const ids = await search(agent, { q: tag });

    expect(ids).not.toContain(me.id);
    // lower(first name), then lower(last name), then id for identical names.
    expect(ids).toEqual([annaFirst.id, anna.id, twin.id, zed.id]);
  });

  it(`F-61: at most ${String(SEARCH_LIMIT_DEFAULT)} results by default, up to ${String(SEARCH_LIMIT_MAX)} on request`, async () => {
    const tag = uniqueTag();
    const { agent } = await signedIn();
    for (let index = 0; index < SEARCH_LIMIT_MAX + 2; index++) {
      await insertUser(testApp.db, { firstName: `${tag}${String(index).padStart(2, '0')}`, lastName: 'Many' });
    }

    expect(await search(agent, { q: tag })).toHaveLength(SEARCH_LIMIT_DEFAULT);
    expect(await search(agent, { q: tag, limit: '3' })).toHaveLength(3);
    expect(await search(agent, { q: tag, limit: String(SEARCH_LIMIT_MAX) })).toHaveLength(SEARCH_LIMIT_MAX);
  });

  it('B-74: % _ and \\ in the query are literal characters', async () => {
    const tag = uniqueTag();
    const { agent } = await signedIn();
    const percent = await insertUser(testApp.db, { firstName: `${tag}50%`, lastName: 'Off' });
    await insertUser(testApp.db, { firstName: `${tag}50x`, lastName: 'Off' });
    const underscore = await insertUser(testApp.db, { firstName: `${tag}a_b`, lastName: 'Under' });
    await insertUser(testApp.db, { firstName: `${tag}axb`, lastName: 'Under' });
    const backslash = await insertUser(testApp.db, { firstName: `${tag}c\\d`, lastName: 'Slash' });
    await insertUser(testApp.db, { firstName: `${tag}cd`, lastName: 'Slash' });

    expect(await search(agent, { q: `${tag}50%` })).toEqual([percent.id]);
    expect(await search(agent, { q: `${tag}a_b` })).toEqual([underscore.id]);
    expect(await search(agent, { q: `${tag}c\\d` })).toEqual([backslash.id]);
    expect(await search(agent, { q: `${tag}%` })).toEqual([]);
    expect(await search(agent, { q: '%' })).toEqual([]);
    expect(await search(agent, { q: '_' })).toEqual([]);
  });

  it('B-49: no match is 200 with an empty list', async () => {
    const { agent } = await signedIn();
    const response = await agent.get('/api/users/search').query({ q: uniqueTag() }).expect(200);
    expect(SearchResponse.parse(response.body)).toEqual({ items: [] });
  });

  it('B-19: results are UserSummary only (no bio, email, hash or key)', async () => {
    const tag = uniqueTag();
    const { agent } = await signedIn();
    const them = await insertUser(testApp.db, { firstName: `${tag}Grace`, bio: 'Private-ish.', avatar: true });

    const response = await agent.get('/api/users/search').query({ q: tag }).expect(200);

    expect(SearchResponse.parse(response.body).items).toEqual([
      {
        id: them.id,
        firstName: them.firstName,
        lastName: them.lastName,
        avatarUrl: `/api/users/${String(them.id)}/avatar?v=${String(parseAvatarKey(them.avatarKey ?? '')?.version)}`,
      },
    ]);
    expect(response.text).not.toContain('Private-ish.');
    expectNoPrivateFields(response, them);
  });

  it.each([
    { name: 'a missing q', query: {} },
    { name: 'an empty q', query: { q: '' } },
    { name: 'a blank q', query: { q: '   ' } },
    { name: 'a q over 100 characters', query: { q: 'a'.repeat(101) } },
    { name: 'a repeated q', query: 'q=ada&q=bob' },
    { name: 'limit 0', query: { q: 'a', limit: '0' } },
    { name: `limit ${String(SEARCH_LIMIT_MAX + 1)}`, query: { q: 'a', limit: String(SEARCH_LIMIT_MAX + 1) } },
    { name: 'a non-numeric limit', query: { q: 'a', limit: 'ten' } },
    { name: 'an exponent limit', query: { q: 'a', limit: '1e1' } },
  ])('F-64: $name is 400 invalid-request', async ({ query }) => {
    const { agent } = await signedIn();

    const problem = expectProblem(await agent.get('/api/users/search').query(query), 400, 'invalid-request');

    expect(problem.errors?.[0]?.location).toBe('query');
  });

  it('is registered before /users/:id, so "search" is never parsed as an id', async () => {
    const { agent } = await signedIn();
    const problem = expectProblem(await agent.get('/api/users/search'), 400, 'invalid-request');
    expect(problem.errors?.[0]).toMatchObject({ location: 'query', path: 'q' });
  });

  it('answers a visitor with 401 unauthorized', async () => {
    expectProblem(await request(testApp.app).get('/api/users/search').query({ q: 'ada' }), 401, 'unauthorized');
  });

  it('F-60, B-68: the query is answered from the three prefix indexes', async () => {
    // The repository's real SQL, captured through a logging Drizzle instance on this file's database.
    const pool = new Pool({ connectionString: currentDatabaseUrl(), max: 1 });
    try {
      const captured: { sql: string; params: unknown[] }[] = [];
      const db = drizzle({
        client: pool,
        schema,
        logger: {
          logQuery: (sql, params) => {
            captured.push({ sql, params });
          },
        },
      });
      await createUsersRepository(db).search({ pattern: prefixPattern('ada'), excludeUserId: 1, limit: 10 });
      const [query] = captured;
      expect(query).toBeDefined();

      const client = await pool.connect();
      try {
        await client.query('begin');
        // The table is tiny, so without this the planner rightly prefers a sequential scan.
        await client.query('set local enable_seqscan = off');
        const result = await client.query<{ 'QUERY PLAN': unknown }>(
          `explain (format json) ${query?.sql ?? ''}`,
          query?.params,
        );
        await client.query('rollback');
        const plan = JSON.stringify(result.rows[0]?.['QUERY PLAN']);
        expect(plan).toContain('users_first_name_prefix_idx');
        expect(plan).toContain('users_last_name_prefix_idx');
        expect(plan).toContain('users_full_name_prefix_idx');
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });
});

describe('GET /api/users/search rate limit', () => {
  const SEARCH_LIMIT = 3;
  let limitedApp: TestApp;

  beforeAll(async () => {
    const limits = resolveLimits({ RATE_LIMIT_MULTIPLIER: TEST_RATE_LIMIT_MULTIPLIER });
    limitedApp = await createTestApp({ limits: { ...limits, search: { limit: SEARCH_LIMIT, windowMs: 60_000 } } });
  });

  afterAll(async () => {
    await limitedApp.close();
  });

  it('429 rate-limited after the per-user budget; other users keep theirs', async () => {
    const [first, second] = [await insertUser(limitedApp.db), await insertUser(limitedApp.db)];
    const agent = request.agent(limitedApp.app);
    await signIn(agent, first.id);
    for (let index = 0; index < SEARCH_LIMIT; index++) {
      await agent.get('/api/users/search').query({ q: 'ada' }).expect(200);
    }

    const limited = await agent.get('/api/users/search').query({ q: 'ada' });

    expectProblem(limited, 429, 'rate-limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // The search budget only covers search: the profile route of the same user still answers.
    await agent.get(`/api/users/${String(first.id)}`).expect(200);

    const other = request.agent(limitedApp.app);
    await signIn(other, second.id);
    await other.get('/api/users/search').query({ q: 'ada' }).expect(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Failing dependencies (B-51) and the database's own guarantees (B-65, B-67)
// ---------------------------------------------------------------------------------------------------------------

describe('B-51: a failing database never leaves a request hanging', () => {
  /** Well below the test timeout: a handler that never answers fails here, naming its route, not as a bare timeout. */
  const ANSWER_WITHIN_MS = 5_000;

  it('B-51, F-106: profile, bio and search answer the generic 500 problem while their table is gone, then recover', async () => {
    const { agent, user } = await signedIn({ bio: 'Before the outage.' });
    const other = await insertUser(testApp.db);
    const calls = [
      { path: '/api/me', send: () => agent.get('/api/me') },
      { path: `/api/users/${String(other.id)}`, send: () => agent.get(`/api/users/${String(other.id)}`) },
      { path: '/api/me', send: () => agent.patch('/api/me').send({ bio: 'During the outage.' }) },
      { path: '/api/users/search', send: () => agent.get('/api/users/search').query({ q: 'test' }) },
    ];

    // Every query of these routes now fails inside Postgres ("relation does not exist"), like a lost database would.
    await testApp.db.execute(sql`alter table users rename to users_offline`);
    try {
      for (const { path, send } of calls) {
        const response = await send().timeout({ response: ANSWER_WITHIN_MS });

        expect(response.status, path).toBe(500);
        expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
        expect(Problem.parse(response.body)).toEqual({
          type: 'about:blank',
          title: 'Internal server error',
          status: 500,
          detail: 'An unexpected error occurred.',
          instance: path,
        });
        expect(response.text).not.toMatch(/users_offline|relation|postgres/i);
        expect(response.text).not.toMatch(LEAK);
      }
    } finally {
      await testApp.db.execute(sql`alter table users_offline rename to users`);
    }

    // The process kept serving: the same session works again, and the failed PATCH stored nothing.
    expect(MeResponse.parse((await agent.get('/api/me').expect(200)).body).user.id).toBe(user.id);
    expect(await storedBio(user.id)).toBe('Before the outage.');
  });
});

/**
 * The name of the constraint that rejected `statement`, read from the Postgres error behind it (Drizzle wraps the
 * driver's error as `cause`). Fails when the statement succeeds or fails for another reason.
 */
async function violatedConstraint(statement: Promise<unknown>): Promise<string> {
  const error: unknown = await statement.then(
    () => {
      throw new Error('the statement succeeded, but a constraint should have rejected it');
    },
    (rejection: unknown) => rejection,
  );
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ('constraint' in current && typeof current.constraint === 'string') return current.constraint;
  }
  throw new Error(`the statement failed without a constraint violation: ${String(error)}`);
}

describe('database constraints behind the API (B-65, B-67)', () => {
  it('B-65: the users table itself refuses names, emails and bios the API would refuse', async () => {
    const cases: readonly [label: string, fields: InsertUserFields, constraint: string][] = [
      ['an empty first name', { firstName: '' }, 'users_first_name_chk'],
      ['an untrimmed first name', { firstName: ' Ada' }, 'users_first_name_chk'],
      [
        `a first name over ${String(NAME_MAX)} characters`,
        { firstName: 'a'.repeat(NAME_MAX + 1) },
        'users_first_name_chk',
      ],
      [
        `a last name over ${String(NAME_MAX)} characters`,
        { lastName: 'l'.repeat(NAME_MAX + 1) },
        'users_last_name_chk',
      ],
      ['an email with upper-case letters', { email: `Ada-${randomUUID()}@Example.com` }, 'users_email_lowercase_chk'],
      [
        `an email over ${String(EMAIL_MAX)} characters`,
        { email: `${'e'.repeat(EMAIL_MAX)}@x.io` },
        'users_email_len_chk',
      ],
      ['an empty bio (no bio is null)', { bio: '' }, 'users_bio_chk'],
      [`a bio over ${String(BIO_MAX)} characters`, { bio: 'b'.repeat(BIO_MAX + 1) }, 'users_bio_chk'],
    ];

    for (const [label, fields, constraint] of cases) {
      expect(await violatedConstraint(insertUser(testApp.db, fields)), label).toBe(constraint);
    }

    // The limits themselves are allowed: the checks mirror the shared Zod limits, they are not stricter.
    const longest = await insertUser(testApp.db, {
      firstName: 'f'.repeat(NAME_MAX),
      lastName: `${'l'.repeat(NAME_MAX - 9)}-${randomUUID().slice(0, 8)}`,
      bio: 'b'.repeat(BIO_MAX),
    });
    expect(longest.firstName).toHaveLength(NAME_MAX);
    expect(longest.bio).toHaveLength(BIO_MAX);
    // An update is checked like an insert.
    expect(
      await violatedConstraint(
        testApp.db
          .update(schema.users)
          .set({ bio: 'b'.repeat(BIO_MAX + 1) })
          .where(eq(schema.users.id, longest.id)),
      ),
    ).toBe('users_bio_chk');
  });

  it('B-65: wall posts and chat messages are checked for trimming and length, up to exactly their limits', async () => {
    const author = await insertUser(testApp.db);
    const post = (body: string) => insertWallPosts(testApp.db, author.id, author.id, 1, { body: () => body });
    const message = (body: string) => insertChatMessages(testApp.db, author.id, 1, { body: () => body });

    expect(await violatedConstraint(post('p'.repeat(POST_MAX + 1)))).toBe('wall_posts_body_chk');
    expect(await violatedConstraint(post(' padded '))).toBe('wall_posts_body_chk');
    expect(await violatedConstraint(post(''))).toBe('wall_posts_body_chk');
    expect(await violatedConstraint(message('m'.repeat(CHAT_MAX + 1)))).toBe('chat_messages_body_chk');
    expect(await violatedConstraint(message('padded '))).toBe('chat_messages_body_chk');
    expect(await violatedConstraint(message(''))).toBe('chat_messages_body_chk');

    await expect(post('p'.repeat(POST_MAX))).resolves.toHaveLength(1);
    await expect(message('m'.repeat(CHAT_MAX))).resolves.toHaveLength(1);
  });

  it('B-65: a leading or trailing line break or tab is refused like a space, as Zod trims it (DATA-MODEL "Text")', async () => {
    // Zod's `.trim()` (String.prototype.trim) removes every kind of whitespace; DATA-MODEL promises that the table
    // rejects any value Zod would have trimmed, also for code paths that skip Zod (seed, scripts).
    const author = await insertUser(testApp.db);
    const cases: readonly [label: string, statement: () => Promise<unknown>, constraint: string][] = [
      [
        'a first name ending in a line break',
        () => insertUser(testApp.db, { firstName: 'Ada\n' }),
        'users_first_name_chk',
      ],
      [
        'a last name starting with a tab',
        () => insertUser(testApp.db, { lastName: '\tLovelace' }),
        'users_last_name_chk',
      ],
      [
        'a post ending in a line break',
        () => insertWallPosts(testApp.db, author.id, author.id, 1, { body: () => 'Hello\n' }),
        'wall_posts_body_chk',
      ],
      [
        'a chat message starting with a tab',
        () => insertChatMessages(testApp.db, author.id, 1, { body: () => '\tHello' }),
        'chat_messages_body_chk',
      ],
    ];

    for (const [label, statement, constraint] of cases) {
      expect(await violatedConstraint(statement()), label).toBe(constraint);
    }
  });

  it('B-67: deleting a user removes their friendships, the posts they wrote or received and their messages', async () => {
    const [mira, jonas, lea] = [
      await insertUser(testApp.db),
      await insertUser(testApp.db),
      await insertUser(testApp.db),
    ];
    await insertFriendship(testApp.db, mira.id, jonas.id, 'accepted');
    await insertFriendship(testApp.db, lea.id, mira.id, 'pending');
    const untouchedFriendship = await insertFriendship(testApp.db, jonas.id, lea.id, 'accepted');
    await insertWallPosts(testApp.db, mira.id, jonas.id, 2); // received by mira
    await insertWallPosts(testApp.db, jonas.id, mira.id, 1); // written by mira
    const [untouchedPost] = await insertWallPosts(testApp.db, jonas.id, lea.id, 1);
    await insertChatMessages(testApp.db, mira.id, 3);
    const [untouchedMessage] = await insertChatMessages(testApp.db, jonas.id, 1);

    await testApp.db.delete(schema.users).where(eq(schema.users.id, mira.id));

    const { friendships, wallPosts, chatMessages } = schema;
    const [miraFriendships] = await testApp.db
      .select({ total: count() })
      .from(friendships)
      .where(or(eq(friendships.requesterId, mira.id), eq(friendships.addresseeId, mira.id)));
    const [miraPosts] = await testApp.db
      .select({ total: count() })
      .from(wallPosts)
      .where(or(eq(wallPosts.wallOwnerId, mira.id), eq(wallPosts.authorId, mira.id)));
    const [miraMessages] = await testApp.db
      .select({ total: count() })
      .from(chatMessages)
      .where(eq(chatMessages.authorId, mira.id));
    expect({ friendships: miraFriendships?.total, posts: miraPosts?.total, messages: miraMessages?.total }).toEqual({
      friendships: 0,
      posts: 0,
      messages: 0,
    });

    // Rows between the other users stay as they were.
    const remainingUsers = await testApp.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(inArray(schema.users.id, [mira.id, jonas.id, lea.id]));
    expect(remainingUsers.map(({ id }) => id).sort((a, b) => a - b)).toEqual([jonas.id, lea.id].sort((a, b) => a - b));
    expect(await testApp.db.select().from(friendships).where(eq(friendships.id, untouchedFriendship.id))).toEqual([
      untouchedFriendship,
    ]);
    expect(
      await testApp.db
        .select()
        .from(wallPosts)
        .where(eq(wallPosts.id, untouchedPost?.id ?? -1)),
    ).toEqual([untouchedPost]);
    expect(
      await testApp.db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.id, untouchedMessage?.id ?? -1)),
    ).toEqual([untouchedMessage]);
  });
});
