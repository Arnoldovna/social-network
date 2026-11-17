import { ChatPage, Problem, problemCode } from '@app/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { insertChatMessages, insertUser } from '../../../../test/db.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { parseAvatarKey } from '../../../shared/media/media-url.js';
import { encodeCursor } from '../../../shared/pagination/cursor.js';
import { fetchAllChatPages, fetchChatPage, signedInChatter, type Chatter } from './fixtures.js';

/**
 * `GET /api/chat/messages` against the real app on this file's own database (ADR-0016): auth, query validation,
 * strict DTOs, newest-first keyset pages (F-76, F-82, F-108, B-19, B-72, B-73). The chat is one global room, so every
 * test asserts only on messages of its own authors. Sending is a socket event (`chat.socket.int.test.ts`).
 */

const MESSAGES_PATH = '/api/chat/messages';

let testApp: TestApp;
let reader: Chatter;

beforeAll(async () => {
  testApp = await createTestApp();
  reader = await signedInChatter(testApp);
});

afterAll(async () => {
  await testApp.close();
});

/** Every message of the chat, newest first, read page by page as the client does. */
async function allMessages() {
  return (await fetchAllChatPages(reader.agent, 50)).flatMap((page) => page.items);
}

function expectProblem(body: unknown, status: number, code: string): Problem {
  const problem = Problem.parse(body);
  expect(problem.status).toBe(status);
  expect(problemCode(problem)).toBe(code);
  return problem;
}

describe('GET /api/chat/messages: access', () => {
  it('401 unauthorized problem without a session', async () => {
    const response = await request(testApp.app).get(MESSAGES_PATH).expect(401);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expectProblem(response.body, 401, 'unauthorized');
  });

  it('401 for an anonymous session (CSRF-bound, not signed in)', async () => {
    const visitor = request.agent(testApp.app);
    await visitor.get('/api/csrf-token').expect(200);
    const response = await visitor.get(MESSAGES_PATH).expect(401);
    expectProblem(response.body, 401, 'unauthorized');
  });

  it('ADR-0005: there is no HTTP send route; a POST passes CSRF and is a 404, never a write', async () => {
    const { agent, user } = await signedInChatter(testApp);
    const response = await agent.post(MESSAGES_PATH).send({ body: 'Over HTTP' }).expect(404);
    expectProblem(response.body, 404, 'not-found');
    const page = await fetchChatPage(agent, { limit: 50 });
    expect(page.items.filter(({ author }) => author.id === user.id)).toHaveLength(0);
  });

  it('F-23: a POST without the CSRF header is refused with 403 before any routing', async () => {
    const { agent } = await signedInChatter(testApp);
    const response = await agent.post(MESSAGES_PATH).unset('x-csrf-token').send({ body: 'x' }).expect(403);
    expectProblem(response.body, 403, 'csrf-invalid');
  });
});

describe('GET /api/chat/messages: pages (F-76, F-82, B-72, B-73)', () => {
  it('F-76: a page with the default size of 20, newest first, with a cursor to older messages', async () => {
    const author = await insertUser(testApp.db);
    // Far in the future, so these are the newest messages of the file no matter which tests ran before.
    const rows = await insertChatMessages(testApp.db, author.id, 25, {
      createdAt: (index) => new Date(Date.UTC(2099, 0, 1, 9, 0, index)),
    });
    const response = await reader.agent.get(MESSAGES_PATH).expect(200);
    const page = ChatPage.parse(response.body);
    expect(page.items.map(({ id }) => id)).toStrictEqual(
      rows
        .map(({ id }) => id)
        .reverse()
        .slice(0, 20),
    );
    expect(page.items.every((message) => message.author.id === author.id)).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it('F-82, B-73, ADR-0014: 25 messages inserted in one statement page through with limit=10, each exactly once, in order', async () => {
    const author = await insertUser(testApp.db);
    // One statement, so all 25 rows share one `now()`: only the id tie-breaker orders them.
    const rows = await insertChatMessages(testApp.db, author.id, 25);
    expect(new Set(rows.map(({ createdAt }) => createdAt.getTime())).size).toBe(1);

    const pages = await fetchAllChatPages(reader.agent, 10);
    expect(pages.every((page) => page.items.length <= 10)).toBe(true);
    expect(pages.at(-1)?.nextCursor).toBeNull();
    const own = pages.flatMap((page) => page.items).filter((message) => message.author.id === author.id);
    expect(own.map(({ id }) => id)).toStrictEqual(rows.map(({ id }) => id).reverse());
  });

  it('B-72: orders by created_at DESC, then id DESC, independent of insertion order', async () => {
    const author = await insertUser(testApp.db);
    const times = [
      '2026-11-02T08:00:00.002Z',
      '2026-11-02T08:00:00.000Z',
      '2026-11-02T08:00:00.001Z',
      '2026-11-02T08:00:00.001Z',
    ].map((iso) => new Date(iso));
    const rows = await insertChatMessages(testApp.db, author.id, times.length, {
      createdAt: (index) => times[index] ?? new Date(),
    });
    const [newest, oldest, tieLow, tieHigh] = rows.map(({ id }) => id);
    const own = (await allMessages()).filter((message) => message.author.id === author.id);
    expect(own.map(({ id }) => id)).toStrictEqual([newest, tieHigh, tieLow, oldest]);
  });

  it('F-108: createdAt is the stored timestamp as a UTC ISO string with milliseconds', async () => {
    const author = await insertUser(testApp.db);
    const createdAt = new Date('2026-11-03T12:34:56.789Z');
    const [row] = await insertChatMessages(testApp.db, author.id, 1, { createdAt, body: () => 'Timed' });
    expect((await allMessages()).find(({ id }) => id === row?.id)).toMatchObject({
      body: 'Timed',
      createdAt: '2026-11-03T12:34:56.789Z',
    });
  });

  it('a cursor past the oldest message is an empty last page', async () => {
    const page = await fetchChatPage(reader.agent, {
      cursor: encodeCursor({ createdAt: new Date('2000-01-01T00:00:00.000Z'), id: 1 }),
    });
    expect(page).toStrictEqual({ items: [], nextCursor: null });
  });
});

describe('GET /api/chat/messages: DTOs (B-19, F-77)', () => {
  it('B-19: each author is a strict UserSummary with the avatar route; no email, hash or key ever appears', async () => {
    const author = await insertUser(testApp.db, { avatar: true, bio: 'Private-ish bio' });
    const [row] = await insertChatMessages(testApp.db, author.id, 1, { body: () => 'With avatar' });
    const message = (await allMessages()).find(({ id }) => id === row?.id);
    const version = parseAvatarKey(author.avatarKey ?? '')?.version;

    expect(message).toStrictEqual({
      id: row?.id,
      author: {
        id: author.id,
        firstName: author.firstName,
        lastName: author.lastName,
        avatarUrl: `/api/users/${String(author.id)}/avatar?v=${version ?? ''}`,
      },
      body: 'With avatar',
      createdAt: row?.createdAt.toISOString(),
    });
    const response = await reader.agent.get(MESSAGES_PATH).query({ limit: 50 }).expect(200);
    for (const secret of [author.email, author.passwordHash, author.avatarKey ?? '', 'Private-ish bio']) {
      expect(response.text).not.toContain(secret);
    }
  });
});

describe('GET /api/chat/messages: validation (400)', () => {
  it.each([
    ['limit=0', { limit: '0' }],
    ['limit=51', { limit: '51' }],
    ['limit=abc', { limit: 'abc' }],
    ['limit=1e1', { limit: '1e1' }],
    ['an empty limit', { limit: '' }],
    ['an empty cursor', { cursor: '' }],
    ['a cursor longer than 200 characters', { cursor: 'a'.repeat(201) }],
  ])('400 invalid-request for %s, with the issue in errors[]', async (_label, query) => {
    const response = await reader.agent.get(MESSAGES_PATH).query(query).expect(400);
    const problem = expectProblem(response.body, 400, 'invalid-request');
    expect(problem.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ location: 'query', path: Object.keys(query)[0] })]),
    );
  });

  it.each([
    ['not base64url', 'not a cursor!'],
    ['base64url of garbage', Buffer.from('garbage').toString('base64url')],
    ['a cursor of the wrong shape', Buffer.from(JSON.stringify({ t: 1, id: 'x' })).toString('base64url')],
    [
      'an id above int32 (would overflow integer in SQL)',
      Buffer.from(JSON.stringify({ t: '2026-11-15T14:05:00.000Z', id: 2 ** 31 })).toString('base64url'),
    ],
  ])('400 invalid-cursor for %s, never a 500', async (_label, cursor) => {
    const response = await reader.agent.get(MESSAGES_PATH).query({ cursor }).expect(400);
    expectProblem(response.body, 400, 'invalid-cursor');
  });

  it('F-113: the problem instance is the path without the query string', async () => {
    const response = await reader.agent.get(MESSAGES_PATH).query({ limit: '0' }).expect(400);
    expect(Problem.parse(response.body).instance).toBe(MESSAGES_PATH);
  });
});
