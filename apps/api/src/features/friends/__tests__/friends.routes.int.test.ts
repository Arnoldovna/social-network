import {
  FriendshipChange,
  FriendshipsResponse,
  FriendshipState,
  Problem,
  problemCode,
  type ProblemCode,
} from '@app/shared';
import { eq, sql } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { insertFriendship, insertUser, type InsertUserFields, type UserRow } from '../../../../test/db.js';
import { csrf, signIn, type TestAgent } from '../../../../test/http.js';
import { connectAs, recordEvents, waitFor, type TestSocket } from '../../../../test/socket.js';
import { createTestApp, TEST_RATE_LIMIT_MULTIPLIER, type TestApp } from '../../../../test/test-app.js';
import { resolveLimits } from '../../../config/limits.js';
import { friendships } from '../../../db/schema/index.js';
import { createAvatarUrl } from '../../../shared/media/media-url.js';
import { rooms } from '../../../shared/realtime/rooms.js';
import { friendshipPairCondition } from '../friendship-reader.js';

/**
 * The friendship routes in the composed app against the file's own Postgres database and the run's Redis (API.md §2
 * "Friendships"; F-45–F-52, F-54, F-57; B-24–B-27, B-52, B-53). Agents sign in through the test-only route with users
 * from `insertUser`; friendships are seeded with `insertFriendship` (ADR-0019 §3).
 */

let testApp: TestApp;
const openSockets: TestSocket[] = [];

beforeAll(async () => {
  testApp = await createTestApp();
});

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.close();
});

afterAll(async () => {
  await testApp.close();
});

interface SignedIn {
  user: UserRow;
  agent: TestAgent;
}

async function signedIn(fields?: InsertUserFields, app: TestApp = testApp): Promise<SignedIn> {
  const user = await insertUser(app.db, fields);
  const agent = request.agent(app.app);
  await signIn(agent, user.id);
  return { user, agent };
}

async function connect({ agent }: SignedIn): Promise<TestSocket> {
  const socket = await connectAs(agent, testApp);
  openSockets.push(socket);
  return socket;
}

function expectProblem(response: Response, status: number, code: ProblemCode): Problem {
  expect(response.status, response.text).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  const problem = Problem.parse(response.body);
  expect(problemCode(problem)).toBe(code);
  return problem;
}

async function rowBetween(a: number, b: number) {
  const [row] = await testApp.db.select().from(friendships).where(friendshipPairCondition(a, b));
  return row;
}

/** A well-formed id no user has (int32 maximum; every file's identity sequence starts at 1). */
const UNKNOWN_USER_ID = 2_147_483_647;

describe('GET /api/friendships', () => {
  it('is 401 unauthorized for a visitor', async () => {
    expectProblem(await request(testApp.app).get('/api/friendships'), 401, 'unauthorized');
  });

  it('F-54, B-52: three lists from the viewer’s point of view, each ordered by name, strict DTOs only', async () => {
    const viewer = await signedIn({ firstName: 'Viewer' });
    const me = viewer.user.id;
    const friendZoe = await insertUser(testApp.db, { firstName: 'zoe', lastName: 'Adams', avatar: true });
    const friendAnna = await insertUser(testApp.db, { firstName: 'Anna', lastName: 'Young' });
    const friendAnnaB = await insertUser(testApp.db, { firstName: 'anna', lastName: 'Baker' });
    const incomingFrom = await insertUser(testApp.db, { firstName: 'Ida' });
    const outgoingTo = await insertUser(testApp.db, { firstName: 'Otto' });
    const stranger = await insertUser(testApp.db);
    const createdAt = new Date('2026-02-01T08:00:00.000Z');
    const acceptedAt = new Date('2026-02-03T09:15:30.250Z');
    await insertFriendship(testApp.db, me, friendZoe.id, 'accepted', { createdAt, acceptedAt });
    await insertFriendship(testApp.db, friendAnna.id, me, 'accepted', { createdAt, acceptedAt });
    await insertFriendship(testApp.db, me, friendAnnaB.id, 'accepted', { createdAt, acceptedAt });
    await insertFriendship(testApp.db, incomingFrom.id, me, 'pending', { createdAt });
    await insertFriendship(testApp.db, me, outgoingTo.id, 'pending', { createdAt });
    await insertFriendship(testApp.db, stranger.id, friendZoe.id, 'accepted');

    const response = await viewer.agent.get('/api/friendships').expect(200);
    const body = FriendshipsResponse.parse(response.body);

    expect(body.friends.map((entry) => entry.user.id)).toEqual([friendAnnaB.id, friendAnna.id, friendZoe.id]);
    expect(body.incoming.map((entry) => entry.user.id)).toEqual([incomingFrom.id]);
    expect(body.outgoing.map((entry) => entry.user.id)).toEqual([outgoingTo.id]);
    expect(body.friends.every((entry) => entry.since === acceptedAt.toISOString())).toBe(true);
    expect(body.incoming[0]?.since).toBe(createdAt.toISOString());
    expect(body.friends[2]?.user).toEqual({
      id: friendZoe.id,
      firstName: 'zoe',
      lastName: 'Adams',
      avatarUrl: createAvatarUrl()(friendZoe.id, friendZoe.avatarKey),
    });
    // B-19: no private column of any listed user reaches the response.
    for (const row of [friendZoe, friendAnna, friendAnnaB, incomingFrom, outgoingTo]) {
      expect(response.text).not.toContain(row.email);
      expect(response.text).not.toContain(row.passwordHash);
    }
    expect(response.text).not.toContain(String(friendZoe.avatarKey));
  });

  it('is three empty lists for a user without friendships', async () => {
    const { agent } = await signedIn();

    const response = await agent.get('/api/friendships').expect(200);

    expect(FriendshipsResponse.parse(response.body)).toEqual({ friends: [], incoming: [], outgoing: [] });
  });
});

describe('POST /api/friendships', () => {
  it('F-46, B-52: 201 pending_outgoing and one pending row requester → addressee', async () => {
    const mira = await signedIn();
    const jonas = await insertUser(testApp.db);

    const response = await mira.agent.post('/api/friendships').send({ userId: jonas.id }).expect(201);

    expect(FriendshipChange.parse(response.body)).toEqual({ userId: jonas.id, state: 'pending_outgoing' });
    expect(await rowBetween(mira.user.id, jonas.id)).toMatchObject({
      requesterId: mira.user.id,
      addresseeId: jonas.id,
      status: 'pending',
      acceptedAt: null,
    });
  });

  it('F-23: is 403 csrf-invalid without the CSRF header and writes nothing', async () => {
    const mira = await signedIn();
    const jonas = await insertUser(testApp.db);

    const response = await mira.agent.post('/api/friendships').unset('x-csrf-token').send({ userId: jonas.id });

    expectProblem(response, 403, 'csrf-invalid');
    expect(await rowBetween(mira.user.id, jonas.id)).toBeUndefined();
  });

  it('is 401 unauthorized for a visitor with a valid CSRF token', async () => {
    const jonas = await insertUser(testApp.db);
    const visitor = request.agent(testApp.app);
    await csrf(visitor);

    expectProblem(await visitor.post('/api/friendships').send({ userId: jonas.id }), 401, 'unauthorized');
  });

  it.each([
    ['a string id', { userId: String(1) }],
    ['a missing id', {}],
    ['zero', { userId: 0 }],
    ['a fraction', { userId: 1.5 }],
    ['an id beyond int32', { userId: 2_147_483_648 }],
  ])('is 422 validation-failed for %s (JSON numbers only, no coercion)', async (_, body) => {
    const { agent } = await signedIn();

    const problem = expectProblem(await agent.post('/api/friendships').send(body), 422, 'validation-failed');

    expect(problem.errors?.[0]).toMatchObject({ location: 'body', path: 'userId' });
  });

  it('B-24: a request to oneself is 422 cannot-befriend-self and writes nothing', async () => {
    const mira = await signedIn();

    const problem = expectProblem(
      await mira.agent.post('/api/friendships').send({ userId: mira.user.id }),
      422,
      'cannot-befriend-self',
    );

    expect(problem.errors?.[0]).toMatchObject({ location: 'body', path: 'userId' });
    expect(await testApp.db.select().from(friendships).where(eq(friendships.requesterId, mira.user.id))).toEqual([]);
  });

  it('B-24: a request to a user that does not exist is 404 user-not-found (never a hanging FK error)', async () => {
    const { agent } = await signedIn();

    expectProblem(await agent.post('/api/friendships').send({ userId: UNKNOWN_USER_ID }), 404, 'user-not-found');
  });

  it.each([
    ['an own pending request', 'outgoing', 'pending'],
    ['a pending request in the other direction', 'incoming', 'pending'],
    ['an accepted friendship', 'incoming', 'accepted'],
  ] as const)('F-46, B-25: is 409 friendship-exists for %s', async (_, direction, status) => {
    const mira = await signedIn();
    const jonas = await insertUser(testApp.db);
    const [from, to] = direction === 'outgoing' ? [mira.user.id, jonas.id] : [jonas.id, mira.user.id];
    const seeded = await insertFriendship(testApp.db, from, to, status);

    expectProblem(await mira.agent.post('/api/friendships').send({ userId: jonas.id }), 409, 'friendship-exists');
    expect(await rowBetween(mira.user.id, jonas.id)).toEqual(seeded);
  });

  it('F-51, B-25: concurrent requests from both sides create exactly one row', async () => {
    const mira = await signedIn();
    const jonas = await signedIn();

    const responses = await Promise.all([
      ...Array.from({ length: 4 }, () => mira.agent.post('/api/friendships').send({ userId: jonas.user.id })),
      ...Array.from({ length: 4 }, () => jonas.agent.post('/api/friendships').send({ userId: mira.user.id })),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    const rows = await testApp.db
      .select()
      .from(friendships)
      .where(friendshipPairCondition(mira.user.id, jonas.user.id));
    expect(rows).toHaveLength(1);
  });
});

describe('POST /api/friendships/:userId/accept', () => {
  it('F-48: the addressee accepts; 200 friends and the row is accepted', async () => {
    const jonas = await signedIn();
    const mira = await insertUser(testApp.db);
    await insertFriendship(testApp.db, mira.id, jonas.user.id, 'pending');

    const response = await jonas.agent.post(`/api/friendships/${String(mira.id)}/accept`).expect(200);

    expect(FriendshipChange.parse(response.body)).toEqual({ userId: mira.id, state: 'friends' });
    const row = await rowBetween(mira.id, jonas.user.id);
    expect(row).toMatchObject({ status: 'accepted', requesterId: mira.id, addresseeId: jonas.user.id });
    expect(row?.acceptedAt).toBeInstanceOf(Date);
  });

  it('F-48, B-26: the requester cannot accept their own request; 404 and the row stays pending', async () => {
    const mira = await signedIn();
    const jonas = await insertUser(testApp.db);
    await insertFriendship(testApp.db, mira.user.id, jonas.id, 'pending');

    expectProblem(
      await mira.agent.post(`/api/friendships/${String(jonas.id)}/accept`),
      404,
      'friend-request-not-found',
    );
    expect(await rowBetween(mira.user.id, jonas.id)).toMatchObject({ status: 'pending', acceptedAt: null });
  });

  it('B-26: accepting a request that does not exist is 404 friend-request-not-found', async () => {
    const jonas = await signedIn();
    const mira = await insertUser(testApp.db);

    expectProblem(
      await jonas.agent.post(`/api/friendships/${String(mira.id)}/accept`),
      404,
      'friend-request-not-found',
    );
    expectProblem(
      await jonas.agent.post(`/api/friendships/${String(UNKNOWN_USER_ID)}/accept`),
      404,
      'friend-request-not-found',
    );
    expect(await rowBetween(mira.id, jonas.user.id)).toBeUndefined();
  });

  it('IDOR: a third user cannot accept a request addressed to someone else', async () => {
    const ada = await signedIn();
    const mira = await insertUser(testApp.db);
    const jonas = await insertUser(testApp.db);
    await insertFriendship(testApp.db, mira.id, jonas.id, 'pending');

    expectProblem(await ada.agent.post(`/api/friendships/${String(mira.id)}/accept`), 404, 'friend-request-not-found');
    expect(await rowBetween(mira.id, jonas.id)).toMatchObject({ status: 'pending' });
  });

  it.each(['abc', '0', '1e3', '0x1F', '07'])('is 400 invalid-request for the path id %j', async (id) => {
    const { agent } = await signedIn();

    const problem = expectProblem(await agent.post(`/api/friendships/${id}/accept`), 400, 'invalid-request');

    expect(problem.errors?.[0]).toMatchObject({ location: 'params', path: 'userId' });
  });

  it('is 403 csrf-invalid without the CSRF header and 401 for a visitor', async () => {
    const jonas = await signedIn();
    const mira = await insertUser(testApp.db);
    await insertFriendship(testApp.db, mira.id, jonas.user.id, 'pending');
    const visitor = request.agent(testApp.app);
    await csrf(visitor);

    expectProblem(
      await jonas.agent.post(`/api/friendships/${String(mira.id)}/accept`).unset('x-csrf-token'),
      403,
      'csrf-invalid',
    );
    expectProblem(await visitor.post(`/api/friendships/${String(mira.id)}/accept`), 401, 'unauthorized');
    expect(await rowBetween(mira.id, jonas.user.id)).toMatchObject({ status: 'pending' });
  });
});

describe('DELETE /api/friendships/:userId', () => {
  it.each([
    ['F-47: the requester cancels a pending request', 'requester', 'pending'],
    ['F-49, B-27: the addressee declines a pending request', 'addressee', 'pending'],
    ['F-50: the requester ends an accepted friendship', 'requester', 'accepted'],
    ['F-50: the addressee ends an accepted friendship', 'addressee', 'accepted'],
  ] as const)('%s: 200 none and the row is gone', async (_, side, status) => {
    const actor = await signedIn();
    const other = await insertUser(testApp.db);
    const [from, to] = side === 'requester' ? [actor.user.id, other.id] : [other.id, actor.user.id];
    await insertFriendship(testApp.db, from, to, status);

    const response = await actor.agent.delete(`/api/friendships/${String(other.id)}`).expect(200);

    expect(FriendshipChange.parse(response.body)).toEqual({ userId: other.id, state: 'none' });
    expect(await rowBetween(actor.user.id, other.id)).toBeUndefined();
  });

  it('is 404 friendship-not-found when the pair has no row, and for oneself', async () => {
    const mira = await signedIn();
    const jonas = await insertUser(testApp.db);

    expectProblem(await mira.agent.delete(`/api/friendships/${String(jonas.id)}`), 404, 'friendship-not-found');
    expectProblem(await mira.agent.delete(`/api/friendships/${String(mira.user.id)}`), 404, 'friendship-not-found');
  });

  it('IDOR: a third user cannot end someone else’s friendship', async () => {
    const ada = await signedIn();
    const mira = await insertUser(testApp.db);
    const jonas = await insertUser(testApp.db);
    await insertFriendship(testApp.db, mira.id, jonas.id, 'accepted');

    expectProblem(await ada.agent.delete(`/api/friendships/${String(jonas.id)}`), 404, 'friendship-not-found');
    expectProblem(await ada.agent.delete(`/api/friendships/${String(mira.id)}`), 404, 'friendship-not-found');
    expect(await rowBetween(mira.id, jonas.id)).toMatchObject({ status: 'accepted' });
  });

  it('is 400 for a malformed id, 403 without CSRF and 401 for a visitor', async () => {
    const mira = await signedIn();
    const jonas = await insertUser(testApp.db);
    await insertFriendship(testApp.db, mira.user.id, jonas.id, 'accepted');
    const visitor = request.agent(testApp.app);
    await csrf(visitor);

    expectProblem(await mira.agent.delete('/api/friendships/abc'), 400, 'invalid-request');
    expectProblem(
      await mira.agent.delete(`/api/friendships/${String(jonas.id)}`).unset('x-csrf-token'),
      403,
      'csrf-invalid',
    );
    expectProblem(await visitor.delete(`/api/friendships/${String(jonas.id)}`), 401, 'unauthorized');
    expect(await rowBetween(mira.user.id, jonas.id)).toMatchObject({ status: 'accepted' });
  });
});

/**
 * The SQLSTATE and constraint of the Postgres error that rejected `statement` (Drizzle wraps the driver's error as
 * `cause`). Fails when the statement succeeds.
 */
async function databaseRejection(statement: Promise<unknown>): Promise<{ code: unknown; constraint: unknown }> {
  const error: unknown = await statement.then(
    () => {
      throw new Error('the statement succeeded, but the database should have rejected it');
    },
    (rejection: unknown) => rejection,
  );
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') {
      return { code: current.code, constraint: 'constraint' in current ? current.constraint : undefined };
    }
  }
  throw new Error(`the statement failed without a database error: ${String(error)}`);
}

describe('B-66: the friendships table enforces its own invariants', () => {
  it('B-66: one row per pair in either direction, no self pair, accepted_at exactly when accepted, a status enum', async () => {
    const [mira, jonas, lea] = [
      await insertUser(testApp.db),
      await insertUser(testApp.db),
      await insertUser(testApp.db),
    ];
    const insert = (values: typeof friendships.$inferInsert) => testApp.db.insert(friendships).values(values);
    await insert({ requesterId: mira.id, addresseeId: jonas.id, status: 'pending' });

    // 23505 unique_violation, 23514 check_violation, 23503 foreign_key_violation, 22P02 invalid_text_representation.
    expect(await databaseRejection(insert({ requesterId: mira.id, addresseeId: jonas.id }))).toEqual({
      code: '23505',
      constraint: 'friendships_pair_idx',
    });
    expect(await databaseRejection(insert({ requesterId: jonas.id, addresseeId: mira.id }))).toEqual({
      code: '23505',
      constraint: 'friendships_pair_idx',
    });
    expect(await databaseRejection(insert({ requesterId: lea.id, addresseeId: lea.id }))).toEqual({
      code: '23514',
      constraint: 'friendships_not_self_chk',
    });
    expect(await databaseRejection(insert({ requesterId: lea.id, addresseeId: mira.id, status: 'accepted' }))).toEqual({
      code: '23514',
      constraint: 'friendships_accepted_at_chk',
    });
    expect(
      await databaseRejection(
        insert({ requesterId: lea.id, addresseeId: mira.id, status: 'pending', acceptedAt: new Date() }),
      ),
    ).toEqual({ code: '23514', constraint: 'friendships_accepted_at_chk' });
    expect(await databaseRejection(insert({ requesterId: lea.id, addresseeId: UNKNOWN_USER_ID }))).toEqual({
      code: '23503',
      constraint: 'friendships_addressee_id_users_id_fk',
    });
    expect(
      await databaseRejection(
        testApp.db.execute(
          sql`insert into friendships (requester_id, addressee_id, status) values (${lea.id}, ${jonas.id}, 'blocked')`,
        ),
      ),
    ).toMatchObject({ code: '22P02' });

    // Only the first row exists; a valid accepted row for another pair is still accepted.
    expect(await rowBetween(mira.id, jonas.id)).toMatchObject({
      requesterId: mira.id,
      addresseeId: jonas.id,
    });
    await expect(
      insert({ requesterId: lea.id, addresseeId: mira.id, status: 'accepted', acceptedAt: new Date() }),
    ).resolves.toBeDefined();
  });
});

describe('B-53: state enum instead of UI labels', () => {
  it('every mutation answers exactly { userId, state } with a state from the shared enum', async () => {
    const mira = await signedIn();
    const jonas = await signedIn();

    const responses = [
      await mira.agent.post('/api/friendships').send({ userId: jonas.user.id }).expect(201),
      await jonas.agent.post(`/api/friendships/${String(mira.user.id)}/accept`).expect(200),
      await mira.agent.delete(`/api/friendships/${String(jonas.user.id)}`).expect(200),
    ];

    expect(responses.map((response) => response.body as unknown)).toEqual([
      { userId: jonas.user.id, state: 'pending_outgoing' },
      { userId: mira.user.id, state: 'friends' },
      { userId: jonas.user.id, state: 'none' },
    ]);
    // `FriendshipChange` is strict: a label field such as the legacy `textInsideButton` would fail the parse.
    for (const response of responses) {
      expect(FriendshipState.options).toContain(FriendshipChange.parse(response.body).state);
    }
  });
});

describe('friendship:changed (F-52, F-57) and wall rooms', () => {
  it('F-52: a new request reaches both users, each from their own point of view, and nobody else', async () => {
    const mira = await signedIn();
    const jonas = await signedIn();
    const ada = await signedIn();
    const [miraSocket, jonasSocket, adaSocket] = await Promise.all([connect(mira), connect(jonas), connect(ada)]);
    const adaEvents = recordEvents(adaSocket, 'friendship:changed');
    const forMira = waitFor(miraSocket, 'friendship:changed');
    const forJonas = waitFor(jonasSocket, 'friendship:changed');

    await mira.agent.post('/api/friendships').send({ userId: jonas.user.id }).expect(201);

    await expect(forMira).resolves.toEqual({ userId: jonas.user.id, state: 'pending_outgoing' });
    await expect(forJonas).resolves.toEqual({ userId: mira.user.id, state: 'pending_incoming' });
    expect(adaEvents).toEqual([]);
  });

  it('F-57: accepting tells both users they are friends', async () => {
    const mira = await signedIn();
    const jonas = await signedIn();
    await insertFriendship(testApp.db, mira.user.id, jonas.user.id, 'pending');
    const [miraSocket, jonasSocket] = await Promise.all([connect(mira), connect(jonas)]);
    const forMira = waitFor(miraSocket, 'friendship:changed');
    const forJonas = waitFor(jonasSocket, 'friendship:changed');

    await jonas.agent.post(`/api/friendships/${String(mira.user.id)}/accept`).expect(200);

    await expect(forMira).resolves.toEqual({ userId: jonas.user.id, state: 'friends' });
    await expect(forJonas).resolves.toEqual({ userId: mira.user.id, state: 'friends' });
  });

  it('F-50: unfriending tells both users and removes each from the other’s wall room, not bystanders', async () => {
    const mira = await signedIn();
    const jonas = await signedIn();
    const ada = await signedIn();
    await insertFriendship(testApp.db, mira.user.id, jonas.user.id, 'accepted');
    const [miraSocket, jonasSocket, adaSocket] = await Promise.all([connect(mira), connect(jonas), connect(ada)]);
    // Joined server-side, as `wall:join` does after its friendship check (the wall unit owns that handler).
    testApp.io.in(rooms.user(mira.user.id)).socketsJoin(rooms.wall(jonas.user.id));
    testApp.io.in(rooms.user(jonas.user.id)).socketsJoin(rooms.wall(mira.user.id));
    testApp.io.in(rooms.user(ada.user.id)).socketsJoin(rooms.wall(jonas.user.id));
    const forMira = waitFor(miraSocket, 'friendship:changed');
    const forJonas = waitFor(jonasSocket, 'friendship:changed');

    await mira.agent.delete(`/api/friendships/${String(jonas.user.id)}`).expect(200);

    await expect(forMira).resolves.toEqual({ userId: jonas.user.id, state: 'none' });
    await expect(forJonas).resolves.toEqual({ userId: mira.user.id, state: 'none' });
    const idsIn = async (room: string) => (await testApp.io.in(room).fetchSockets()).map((socket) => socket.id);
    expect(await idsIn(rooms.wall(jonas.user.id))).toEqual([adaSocket.id]);
    expect(await idsIn(rooms.wall(mira.user.id))).toEqual([]);
  });

  it('a failed mutation emits nothing', async () => {
    const mira = await signedIn();
    const jonas = await signedIn();
    const [miraSocket, jonasSocket] = await Promise.all([connect(mira), connect(jonas)]);
    const miraEvents = recordEvents(miraSocket, 'friendship:changed');
    const jonasEvents = recordEvents(jonasSocket, 'friendship:changed');

    await mira.agent.post(`/api/friendships/${String(jonas.user.id)}/accept`).expect(404);
    await mira.agent.delete(`/api/friendships/${String(jonas.user.id)}`).expect(404);
    // A successful mutation afterwards orders the check by a real delivery instead of a sleep.
    const delivered = Promise.all([
      waitFor(jonasSocket, 'friendship:changed'),
      waitFor(miraSocket, 'friendship:changed'),
    ]);
    await mira.agent.post('/api/friendships').send({ userId: jonas.user.id }).expect(201);
    await delivered;

    expect(jonasEvents).toEqual([{ userId: mira.user.id, state: 'pending_incoming' }]);
    expect(miraEvents).toEqual([{ userId: jonas.user.id, state: 'pending_outgoing' }]);
  });
});

describe('write limiter (60 / 10 min per user in production)', () => {
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

  it('answers the third friendship mutation of a user with 429 rate-limited; reads and other users are unaffected', async () => {
    const mira = await signedIn(undefined, limitedApp);
    const jonas = await signedIn(undefined, limitedApp);

    await mira.agent.post('/api/friendships').send({ userId: jonas.user.id }).expect(201);
    await mira.agent.delete(`/api/friendships/${String(jonas.user.id)}`).expect(200);
    const limited = await mira.agent.post('/api/friendships').send({ userId: jonas.user.id });

    expectProblem(limited, 429, 'rate-limited');
    expect(limited.headers['retry-after']).toMatch(/^\d+$/);
    await mira.agent.get('/api/friendships').expect(200);
    await jonas.agent.post('/api/friendships').send({ userId: mira.user.id }).expect(201);
  });
});
