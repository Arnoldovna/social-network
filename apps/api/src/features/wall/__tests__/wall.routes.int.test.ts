import { CreatePostResponse, POST_MAX, WallPage, type WallPost } from '@app/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { insertUser, insertWallPosts } from '../../../../test/db.js';
import { csrf, type TestAgent } from '../../../../test/http.js';
import { createTestApp, TEST_RATE_LIMIT_MULTIPLIER, type TestApp } from '../../../../test/test-app.js';
import { resolveLimits } from '../../../config/limits.js';
import { wallPosts } from '../../../db/schema/index.js';
import { CSRF_HEADER } from '../../../shared/security/csrf.js';
import { createWallCast, expectProblem, signedInUser, type WallCast } from './fixtures.js';

/**
 * The wall's HTTP routes against the real app, Postgres and Redis (API.md §2 "Wall"): status codes, problem+json,
 * auth, CSRF, the owner-or-friend rule (F-65, F-66, ADR-0011), deletion rights (F-71) and keyset pagination (F-70,
 * ADR-0014). Every test creates its own users and asserts only on their walls.
 */

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

const postsPath = (wallOwnerId: number | string): string => `/api/users/${String(wallOwnerId)}/posts`;
const postPath = (postId: number | string): string => `/api/posts/${String(postId)}`;

/** A user id no test creates (int32, so it passes `IdParam`). */
const UNKNOWN_ID = 2_000_000_000;

async function storedPosts(wallOwnerId: number) {
  return testApp.db.select().from(wallPosts).where(eq(wallPosts.wallOwnerId, wallOwnerId));
}

/** Posts and expects 201; returns the parsed `WallPost`. */
async function createPost(agent: TestAgent, wallOwnerId: number, body: string): Promise<WallPost> {
  const response = await agent.post(postsPath(wallOwnerId)).send({ body });
  expect(response.status).toBe(201);
  return CreatePostResponse.parse(response.body).post;
}

/** Follows `nextCursor` until the last page; returns every page as received. */
async function fetchAllPages(agent: TestAgent, wallOwnerId: number, limit: number): Promise<WallPage[]> {
  const pages: WallPage[] = [];
  let cursor: string | null = null;
  do {
    const response = await agent
      .get(postsPath(wallOwnerId))
      .query({ limit: String(limit), ...(cursor === null ? {} : { cursor }) });
    expect(response.status).toBe(200);
    const page = WallPage.parse(response.body);
    pages.push(page);
    cursor = page.nextCursor;
    // A guard against an endless loop if a cursor ever stopped advancing.
    expect(pages.length).toBeLessThan(20);
  } while (cursor !== null);
  return pages;
}

describe('GET /api/users/:id/posts (F-65, F-69, F-70, B-23)', () => {
  let cast: WallCast;

  beforeAll(async () => {
    cast = await createWallCast(testApp);
  });

  it.each([
    ['the owner', 'owner'],
    ['a friend who sent the request', 'friend'],
    ['a friend the owner invited', 'invitedFriend'],
  ] as const)('F-65: %s reads the wall', async (_who, viewer) => {
    const [row] = await insertWallPosts(testApp.db, cast.owner.user.id, cast.owner.user.id, 1);

    const response = await cast[viewer].agent.get(postsPath(cast.owner.user.id));

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(WallPage.parse(response.body).items.map(({ id }) => id)).toContain(row?.id);
  });

  it('F-69: each post carries the author summary (with avatar URL), body and millisecond ISO timestamp only', async () => {
    const [row] = await insertWallPosts(testApp.db, cast.owner.user.id, cast.friend.user.id, 1, {
      body: () => 'F-69 shape',
    });
    const response = await cast.owner.agent.get(postsPath(cast.owner.user.id));

    const post = WallPage.parse(response.body).items.find(({ id }) => id === row?.id);
    expect(post).toStrictEqual({
      id: row?.id,
      wallOwnerId: cast.owner.user.id,
      author: {
        id: cast.friend.user.id,
        firstName: cast.friend.user.firstName,
        lastName: cast.friend.user.lastName,
        avatarUrl: expect.stringMatching(
          new RegExp(`^/api/users/${String(cast.friend.user.id)}/avatar\\?v=[0-9a-f-]{36}$`),
        ) as string,
      },
      body: 'F-69 shape',
      createdAt: row?.createdAt.toISOString(),
    });
    // B-19: nothing internal leaks through the join.
    expect(response.text).not.toContain(cast.friend.user.email);
    expect(response.text).not.toContain('avatars/');
    expect(response.text).not.toContain('$argon2id$');
  });

  it.each([
    ['a user with a pending request to the owner', 'requester'],
    ['a user the owner sent a pending request', 'addressee'],
    ['a friend of a friend', 'stranger'],
  ] as const)('B-23: %s gets 403 wall-forbidden', async (_who, viewer) => {
    const response = await cast[viewer].agent.get(postsPath(cast.owner.user.id));
    const problem = expectProblem(response, 403, 'wall-forbidden');
    expect(problem.instance).toBe(postsPath(cast.owner.user.id));
    expect(response.text).not.toContain('"items"');
  });

  it('F-65: an unknown user is 404 user-not-found', async () => {
    expectProblem(await cast.owner.agent.get(postsPath(UNKNOWN_ID)), 404, 'user-not-found');
  });

  it('401 unauthorized without a session', async () => {
    expectProblem(await request(testApp.app).get(postsPath(cast.owner.user.id)), 401, 'unauthorized');
  });

  it.each(['abc', '0', '07', '1e3', '-1', '2147483648'])('400 invalid-request for the id %j', async (id) => {
    expectProblem(await cast.owner.agent.get(postsPath(id)), 400, 'invalid-request');
  });

  it.each(['0', '51', '1e1', '-1', '2.5', ''])('400 invalid-request for limit=%j', async (limit) => {
    const response = await cast.owner.agent.get(postsPath(cast.owner.user.id)).query({ limit });
    expectProblem(response, 400, 'invalid-request');
  });

  it.each([
    ['not base64url', 'not a cursor!'],
    ['base64url of non-JSON', Buffer.from('nope').toString('base64url')],
    [
      'an id beyond int32',
      Buffer.from(JSON.stringify({ t: '2026-01-01T00:00:00.000Z', id: 2 ** 31 })).toString('base64url'),
    ],
    [
      'a timestamp without milliseconds',
      Buffer.from(JSON.stringify({ t: '2026-01-01T00:00:00Z', id: 1 })).toString('base64url'),
    ],
  ])('400 invalid-cursor for %s', async (_what, cursor) => {
    const response = await cast.owner.agent.get(postsPath(cast.owner.user.id)).query({ cursor });
    const problem = expectProblem(response, 400, 'invalid-cursor');
    // F-113: the instance never echoes the query string.
    expect(problem.instance).toBe(postsPath(cast.owner.user.id));
  });
});

describe('pagination (F-70, B-72, B-73, ADR-0014)', () => {
  it('B-73: 25 posts inserted in one statement page through with limit=10, every id exactly once, in order', async () => {
    const { user, agent } = await signedInUser(testApp);
    // One statement: all 25 rows share one `now()`, so only the id tie-breaker orders them (ADR-0014).
    const rows = await insertWallPosts(testApp.db, user.id, user.id, 25);
    expect(new Set(rows.map(({ createdAt }) => createdAt.getTime())).size).toBe(1);

    const pages = await fetchAllPages(agent, user.id, 10);

    expect(pages.map(({ items }) => items.length)).toEqual([10, 10, 5]);
    expect(pages.map(({ nextCursor }) => nextCursor === null)).toEqual([false, false, true]);
    const ids = pages.flatMap(({ items }) => items.map(({ id }) => id));
    expect(ids).toEqual(rows.map(({ id }) => id).reverse());
    expect(new Set(ids).size).toBe(25);
  });

  it('B-72: newest first by createdAt in SQL, independent of id order; ties broken by id DESC', async () => {
    const { user, agent } = await signedInUser(testApp);
    const base = Date.parse('2026-05-01T10:00:00.000Z');
    // Ids ascend while timestamps descend, with two pairs sharing a millisecond.
    const offsets = [0, -1000, -1000, -2000, -2000, -3000];
    const rows = await insertWallPosts(testApp.db, user.id, user.id, offsets.length, {
      createdAt: (index) => new Date(base + (offsets[index] ?? 0)),
    });

    const ids = (await fetchAllPages(agent, user.id, 4)).flatMap(({ items }) => items.map(({ id }) => id));

    const expected = [...rows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
      .map(({ id }) => id);
    expect(ids).toEqual(expected);
    expect(ids).toEqual([rows[0]?.id, rows[2]?.id, rows[1]?.id, rows[4]?.id, rows[3]?.id, rows[5]?.id]);
  });

  it('F-70: the default page size is 20 and a wall only lists its own posts', async () => {
    const { user, agent } = await signedInUser(testApp);
    const other = await insertUser(testApp.db);
    await insertWallPosts(testApp.db, user.id, user.id, 21);
    await insertWallPosts(testApp.db, other.id, other.id, 3);

    const response = await agent.get(postsPath(user.id));

    const page = WallPage.parse(response.body);
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).not.toBeNull();
    expect(page.items.every(({ wallOwnerId }) => wallOwnerId === user.id)).toBe(true);
  });

  it('an empty wall is an empty page without a cursor', async () => {
    const { user, agent } = await signedInUser(testApp);
    const response = await agent.get(postsPath(user.id));
    expect(response.status).toBe(200);
    expect(WallPage.parse(response.body)).toStrictEqual({ items: [], nextCursor: null });
  });

  it('a post created after the first page was loaded never shows up again on an older page', async () => {
    const { user, agent } = await signedInUser(testApp);
    await insertWallPosts(testApp.db, user.id, user.id, 3, {
      createdAt: (index) => new Date(Date.parse('2026-05-02T10:00:00.000Z') - index * 1000),
    });
    const first = WallPage.parse((await agent.get(postsPath(user.id)).query({ limit: '2' })).body);
    const fresh = await createPost(agent, user.id, 'Arrived in between');

    const second = WallPage.parse(
      (await agent.get(postsPath(user.id)).query({ limit: '2', cursor: first.nextCursor ?? '' })).body,
    );

    expect(second.items.map(({ id }) => id)).not.toContain(fresh.id);
    expect([...first.items, ...second.items]).toHaveLength(3);
  });
});

describe('POST /api/users/:id/posts (F-66, F-67, B-22, B-41, B-70)', () => {
  let cast: WallCast;

  beforeAll(async () => {
    cast = await createWallCast(testApp);
  });

  it.each([
    ['the owner on their own wall', 'owner'],
    ['a friend who sent the request', 'friend'],
    ['a friend the owner invited', 'invitedFriend'],
  ] as const)('F-66: %s posts and gets 201 with the stored, trimmed post', async (_who, author) => {
    const response = await cast[author].agent.post(postsPath(cast.owner.user.id)).send({ body: '  Hello wall \n' });

    expect(response.status).toBe(201);
    const { post } = CreatePostResponse.parse(response.body);
    expect(post).toMatchObject({
      wallOwnerId: cast.owner.user.id,
      author: { id: cast[author].user.id, firstName: cast[author].user.firstName },
      body: 'Hello wall',
    });
    const [row] = await testApp.db.select().from(wallPosts).where(eq(wallPosts.id, post.id));
    expect(row).toMatchObject({ wallOwnerId: cast.owner.user.id, authorId: cast[author].user.id, body: 'Hello wall' });
    expect(post.createdAt).toBe(row?.createdAt.toISOString());
  });

  it('B-41: the new post carries its own row id, and deleting it deletes exactly that post', async () => {
    const { user: owner, agent } = await signedInUser(testApp);
    // Enough earlier posts that a post with id = the author's user id would exist in a confused implementation.
    const earlier = await insertWallPosts(testApp.db, owner.id, owner.id, 3);

    const post = await createPost(agent, owner.id, 'Fresh');

    expect(post.id).not.toBe(owner.id);
    expect(post.id).toBeGreaterThan(Math.max(...earlier.map(({ id }) => id)));
    expect(post.author.id).toBe(owner.id);

    expect((await agent.delete(postPath(post.id))).status).toBe(204);
    expect((await storedPosts(owner.id)).map(({ id }) => id).sort((a, b) => a - b)).toEqual(
      earlier.map(({ id }) => id),
    );
  });

  it.each([
    ['a user with a pending request to the owner', 'requester'],
    ['a user the owner sent a pending request', 'addressee'],
    ['a friend of a friend', 'stranger'],
  ] as const)('B-22: %s gets 403 wall-write-forbidden and nothing is stored', async (_who, author) => {
    const before = (await storedPosts(cast.owner.user.id)).length;
    const response = await cast[author].agent.post(postsPath(cast.owner.user.id)).send({ body: 'Spam' });
    expectProblem(response, 403, 'wall-write-forbidden');
    expect(await storedPosts(cast.owner.user.id)).toHaveLength(before);
  });

  it('404 user-not-found for an unknown wall', async () => {
    const response = await cast.owner.agent.post(postsPath(UNKNOWN_ID)).send({ body: 'Hello?' });
    expectProblem(response, 404, 'user-not-found');
  });

  it.each([
    ['a blank body (B-70)', { body: '   \n\t ' }],
    ['an empty body', { body: '' }],
    [`a body over ${String(POST_MAX)} characters`, { body: 'x'.repeat(POST_MAX + 1) }],
    ['a missing body', {}],
    ['a non-string body', { body: 42 }],
  ])('F-67: 422 validation-failed for %s; nothing is stored', async (_what, payload) => {
    const before = (await storedPosts(cast.owner.user.id)).length;
    const response = await cast.owner.agent.post(postsPath(cast.owner.user.id)).send(payload);
    const problem = expectProblem(response, 422, 'validation-failed');
    expect(problem.errors?.[0]).toMatchObject({ location: 'body', path: 'body' });
    expect(await storedPosts(cast.owner.user.id)).toHaveLength(before);
  });

  it('B-70: a whitespace-only post is rejected by the API (422) and could not be stored by the table either', async () => {
    const response = await cast.owner.agent.post(postsPath(cast.owner.user.id)).send({ body: ' \u00a0\n ' });
    expectProblem(response, 422, 'validation-failed');
    // The second line of defence: `wall_posts_body_chk` rejects an untrimmed or empty body (DATA-MODEL).
    await expect(
      insertWallPosts(testApp.db, cast.owner.user.id, cast.owner.user.id, 1, { body: () => ' ' }),
    ).rejects.toThrow();
  });

  it(`F-67: a body of exactly ${String(POST_MAX)} characters after trimming is accepted`, async () => {
    const post = await createPost(cast.owner.agent, cast.owner.user.id, ` ${'x'.repeat(POST_MAX)} `);
    expect(post.body).toHaveLength(POST_MAX);
  });

  it('400 invalid-request for a malformed wall id', async () => {
    expectProblem(await cast.owner.agent.post(postsPath('abc')).send({ body: 'x' }), 400, 'invalid-request');
  });

  it('401 unauthorized for an anonymous session with a valid CSRF token', async () => {
    const anonymous = request.agent(testApp.app);
    await csrf(anonymous);
    const response = await anonymous.post(postsPath(cast.owner.user.id)).send({ body: 'Hello' });
    expectProblem(response, 401, 'unauthorized');
  });

  it('F-23: 403 csrf-invalid without the CSRF header; nothing is stored', async () => {
    const before = (await storedPosts(cast.owner.user.id)).length;
    const response = await cast.owner.agent
      .post(postsPath(cast.owner.user.id))
      .unset(CSRF_HEADER)
      .send({ body: 'Forged' });
    expectProblem(response, 403, 'csrf-invalid');
    expect(await storedPosts(cast.owner.user.id)).toHaveLength(before);
  });
});

describe('DELETE /api/posts/:id (F-71, B-21)', () => {
  let cast: WallCast;

  beforeAll(async () => {
    cast = await createWallCast(testApp);
  });

  async function friendPostOnOwnerWall(): Promise<WallPost> {
    return createPost(cast.friend.agent, cast.owner.user.id, 'From a friend');
  }

  async function postExists(postId: number): Promise<boolean> {
    return (await testApp.db.select().from(wallPosts).where(eq(wallPosts.id, postId))).length === 1;
  }

  it('F-71: the author deletes their own post on a friend’s wall (204, empty body)', async () => {
    const post = await friendPostOnOwnerWall();
    const response = await cast.friend.agent.delete(postPath(post.id));
    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(await postExists(post.id)).toBe(false);
  });

  it('F-71: the wall owner deletes a friend’s post on their wall', async () => {
    const post = await friendPostOnOwnerWall();
    expect((await cast.owner.agent.delete(postPath(post.id))).status).toBe(204);
    expect(await postExists(post.id)).toBe(false);
  });

  it.each([
    ['another friend of the owner who is not the author', 'invitedFriend'],
    ['a friend of the author who is not the wall owner', 'stranger'],
    ['a user with a pending request to the owner', 'requester'],
  ] as const)('B-21: %s gets 403 post-delete-forbidden and the post stays', async (_who, deleter) => {
    const post = await friendPostOnOwnerWall();
    expectProblem(await cast[deleter].agent.delete(postPath(post.id)), 403, 'post-delete-forbidden');
    expect(await postExists(post.id)).toBe(true);
  });

  it('B-21: the author cannot delete a post they wrote after the owner deleted it (404, not 403)', async () => {
    const post = await friendPostOnOwnerWall();
    expect((await cast.owner.agent.delete(postPath(post.id))).status).toBe(204);
    expectProblem(await cast.friend.agent.delete(postPath(post.id)), 404, 'post-not-found');
  });

  it('404 post-not-found for an unknown post', async () => {
    expectProblem(await cast.owner.agent.delete(postPath(UNKNOWN_ID)), 404, 'post-not-found');
  });

  it('400 invalid-request for a malformed post id', async () => {
    expectProblem(await cast.owner.agent.delete(postPath('1.5')), 400, 'invalid-request');
  });

  it('401 unauthorized for an anonymous session with a valid CSRF token', async () => {
    const post = await friendPostOnOwnerWall();
    const anonymous = request.agent(testApp.app);
    await csrf(anonymous);
    expectProblem(await anonymous.delete(postPath(post.id)), 401, 'unauthorized');
    expect(await postExists(post.id)).toBe(true);
  });

  it('F-23: 403 csrf-invalid without the CSRF header; the post stays', async () => {
    const post = await friendPostOnOwnerWall();
    expectProblem(await cast.owner.agent.delete(postPath(post.id)).unset(CSRF_HEADER), 403, 'csrf-invalid');
    expect(await postExists(post.id)).toBe(true);
  });
});

describe('write limiter (API.md §2: 60 wall and friendship writes per 10 min per user)', () => {
  let limitedApp: TestApp;

  beforeAll(async () => {
    limitedApp = await createTestApp({
      limits: {
        ...resolveLimits({ RATE_LIMIT_MULTIPLIER: TEST_RATE_LIMIT_MULTIPLIER }),
        write: { limit: 2, windowMs: 60_000 },
      },
    });
  });

  afterAll(async () => {
    await limitedApp.close();
  });

  it('429 rate-limited once a user spent the write budget on posts and deletes; reading stays allowed', async () => {
    const { user, agent } = await signedInUser(limitedApp);
    const other = await signedInUser(limitedApp);

    const post = await createPost(agent, user.id, 'One');
    expect((await agent.delete(postPath(post.id))).status).toBe(204);

    const response = await agent.post(postsPath(user.id)).send({ body: 'Three' });
    expectProblem(response, 429, 'rate-limited');
    expect(response.headers['retry-after']).toBeDefined();
    expect((await agent.get(postsPath(user.id))).status).toBe(200);
    // Keyed by user: another user's budget is untouched.
    expect((await other.agent.post(postsPath(other.user.id)).send({ body: 'Mine' })).status).toBe(201);
  });
});
