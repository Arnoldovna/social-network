import { CreatePostResponse, WallPost } from '@app/shared';
import { and, eq, or } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { insertFriendship } from '../../../../test/db.js';
import { recordEvents, waitFor, waitForDisconnect, type TestSocket } from '../../../../test/socket.js';
import { createTestApp, TEST_RATE_LIMIT_MULTIPLIER, type TestApp } from '../../../../test/test-app.js';
import { resolveLimits } from '../../../config/limits.js';
import { friendships, wallPosts } from '../../../db/schema/index.js';
import { rooms } from '../../../shared/realtime/rooms.js';
import { sessionKeyPrefix } from '../../../shared/security/session.js';
import {
  createSocketTracker,
  createWallCast,
  emitWall,
  joinWall,
  signedInUser,
  type SignedInUser,
  type WallCast,
} from './fixtures.js';

/**
 * `wall:join` / `wall:leave` and the wall events against the real app and socket.io server on an ephemeral port
 * (API.md §3, ADR-0008): a socket receives `wall:post-created` / `wall:post-deleted` only for a wall it joined, and it
 * can only join a wall its user may read (F-72, B-23, B-39, B-40). Payloads are validated through the ack (F-112,
 * B-48). "Received nothing" is always checked after a real delivery to another socket, never after a sleep.
 */

let testApp: TestApp;
const sockets = createSocketTracker();

beforeAll(async () => {
  testApp = await createTestApp();
});

afterEach(() => {
  sockets.closeAll();
});

afterAll(async () => {
  await testApp.close();
});

const postsPath = (wallOwnerId: number): string => `/api/users/${String(wallOwnerId)}/posts`;

async function connect(user: SignedInUser): Promise<TestSocket> {
  return sockets.connect(testApp, user.agent);
}

async function createPost(author: SignedInUser, wallOwnerId: number, body: string): Promise<WallPost> {
  const response = await author.agent.post(postsPath(wallOwnerId)).send({ body });
  expect(response.status).toBe(201);
  return CreatePostResponse.parse(response.body).post;
}

/** Whether any server-side socket of `userId` is in the wall room of `wallOwnerId`. */
async function isInWallRoom(userId: number, wallOwnerId: number): Promise<boolean> {
  const members = await testApp.io.in(rooms.wall(wallOwnerId)).fetchSockets();
  return members.some((socket) => socket.data.user.id === userId);
}

describe('wall:join (B-23, B-39)', () => {
  let cast: WallCast;

  beforeAll(async () => {
    cast = await createWallCast(testApp);
  });

  it.each([
    ['the owner', 'owner'],
    ['a friend who sent the request', 'friend'],
    ['a friend the owner invited', 'invitedFriend'],
  ] as const)('%s joins the wall room', async (_who, viewer) => {
    const socket = await connect(cast[viewer]);
    await joinWall(socket, cast.owner.user.id);
    expect(await isInWallRoom(cast[viewer].user.id, cast.owner.user.id)).toBe(true);
  });

  it.each([
    ['a user with a pending request to the owner', 'requester'],
    ['a user the owner sent a pending request', 'addressee'],
    ['a friend of a friend', 'stranger'],
  ] as const)('B-39: %s is acked forbidden and stays out of the room', async (_who, viewer) => {
    const socket = await connect(cast[viewer]);
    expect(await emitWall(socket, 'wall:join', { userId: cast.owner.user.id })).toStrictEqual({
      ok: false,
      error: { code: 'forbidden', message: expect.any(String) as string },
    });
    expect(await isInWallRoom(cast[viewer].user.id, cast.owner.user.id)).toBe(false);
    // Still connected: a refused join is an answer, not a reason to drop the socket.
    expect(socket.connected).toBe(true);
  });

  it('an unknown user is acked not-found', async () => {
    const socket = await connect(cast.owner);
    expect(await emitWall(socket, 'wall:join', { userId: 2_000_000_000 })).toStrictEqual({
      ok: false,
      error: { code: 'not-found', message: expect.any(String) as string },
    });
  });

  it('an unfriended user can no longer join: the friendship is read on every join', async () => {
    const owner = await signedInUser(testApp);
    const former = await signedInUser(testApp);
    await insertFriendship(testApp.db, former.user.id, owner.user.id, 'accepted');
    const socket = await connect(former);
    await joinWall(socket, owner.user.id);
    await emitWall(socket, 'wall:leave', { userId: owner.user.id });

    await testApp.db
      .delete(friendships)
      .where(
        or(
          and(eq(friendships.requesterId, former.user.id), eq(friendships.addresseeId, owner.user.id)),
          and(eq(friendships.requesterId, owner.user.id), eq(friendships.addresseeId, former.user.id)),
        ),
      );

    expect(await emitWall(socket, 'wall:join', { userId: owner.user.id })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
  });
});

describe('payload validation (F-112, B-48)', () => {
  let user: SignedInUser;

  beforeAll(async () => {
    user = await signedInUser(testApp);
  });

  it.each([
    ['a string id', { userId: String(1) }],
    ['a missing id', {}],
    ['zero', { userId: 0 }],
    ['a negative id', { userId: -1 }],
    ['a fraction', { userId: 1.5 }],
    ['an id beyond int32', { userId: 2 ** 31 }],
    ['an array', [1]],
    ['null', null],
    ['a bare number', 1],
  ])('wall:join with %s is acked validation-failed and the socket stays usable', async (_what, payload) => {
    const socket = await connect(user);
    expect(await emitWall(socket, 'wall:join', payload)).toStrictEqual({
      ok: false,
      error: { code: 'validation-failed', message: expect.any(String) as string },
    });
    await joinWall(socket, user.user.id);
  });

  it('wall:leave validates its payload too', async () => {
    const socket = await connect(user);
    expect(await emitWall(socket, 'wall:leave', { userId: 'me' })).toMatchObject({
      ok: false,
      error: { code: 'validation-failed' },
    });
  });

  it('an emit without an ack callback is ignored safely and the server keeps serving the socket', async () => {
    const socket = await connect(user);
    // The typed client API always requires the ack, as the web app must pass one; a hostile client need not.
    const rawEmit = socket.emit.bind(socket);
    Reflect.apply(rawEmit, undefined, ['wall:join', { userId: user.user.id }]);
    Reflect.apply(rawEmit, undefined, ['wall:join', { userId: 'broken' }, 'not a function']);
    await joinWall(socket, user.user.id);
    expect(socket.connected).toBe(true);
  });
});

describe('wall:post-created / wall:post-deleted only reach the wall room (F-72, B-39, B-40)', () => {
  let cast: WallCast;

  beforeAll(async () => {
    cast = await createWallCast(testApp);
  });

  it('B-40: a new post reaches every joined socket of the wall, nobody else', async () => {
    const ownerSocket = await connect(cast.owner);
    const friendSocket = await connect(cast.friend);
    const invitedSocket = await connect(cast.invitedFriend); // connected, but has not joined this wall
    const strangerSocket = await connect(cast.stranger); // joined another wall (the friend's)
    await joinWall(ownerSocket, cast.owner.user.id);
    await joinWall(friendSocket, cast.owner.user.id);
    await joinWall(strangerSocket, cast.friend.user.id);
    const atInvited = recordEvents(invitedSocket, 'wall:post-created');
    const atStranger = recordEvents(strangerSocket, 'wall:post-created');
    const atOwner = waitFor(ownerSocket, 'wall:post-created');
    const atFriend = waitFor(friendSocket, 'wall:post-created');

    const post = await createPost(cast.friend, cast.owner.user.id, 'Realtime hello');

    // The event is the HTTP response's DTO: the persisted row with its own id (B-41, B-75).
    await expect(atOwner).resolves.toStrictEqual(post);
    await expect(atFriend).resolves.toStrictEqual(post);
    expect(() => WallPost.parse(post)).not.toThrow();
    expect(atInvited).toEqual([]);
    expect(atStranger).toEqual([]);
  });

  it('B-75: the event is the complete persisted post with its author, straight from the insert', async () => {
    const ownerSocket = await connect(cast.owner);
    await joinWall(ownerSocket, cast.owner.user.id);
    const event = waitFor(ownerSocket, 'wall:post-created');

    await createPost(cast.friend, cast.owner.user.id, 'Complete payload');

    const payload = await event;
    const [row] = await testApp.db.select().from(wallPosts).where(eq(wallPosts.id, payload.id));
    expect(payload).toStrictEqual({
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
      body: 'Complete payload',
      createdAt: row?.createdAt.toISOString(),
    });
  });

  it('B-39: a socket whose join was refused never receives the wall’s posts', async () => {
    const ownerSocket = await connect(cast.owner);
    const requesterSocket = await connect(cast.requester);
    await joinWall(ownerSocket, cast.owner.user.id);
    expect(await emitWall(requesterSocket, 'wall:join', { userId: cast.owner.user.id })).toMatchObject({ ok: false });
    const atRequester = recordEvents(requesterSocket, 'wall:post-created');
    const atOwner = waitFor(ownerSocket, 'wall:post-created');

    await createPost(cast.owner, cast.owner.user.id, 'Friends only');
    await atOwner;

    expect(atRequester).toEqual([]);
  });

  it('every open tab of a joined user gets the event, but only the tabs that joined', async () => {
    const tabA = await connect(cast.friend);
    const tabB = await connect(cast.friend);
    const marker = await connect(cast.owner);
    await joinWall(tabA, cast.owner.user.id);
    await joinWall(marker, cast.owner.user.id);
    const atB = recordEvents(tabB, 'wall:post-created');
    const atA = waitFor(tabA, 'wall:post-created');
    const atMarker = waitFor(marker, 'wall:post-created');

    const post = await createPost(cast.owner, cast.owner.user.id, 'Per tab');

    await expect(atA).resolves.toStrictEqual(post);
    await atMarker;
    expect(atB).toEqual([]);
  });

  it('F-71: a delete emits wall:post-deleted { id, wallOwnerId } to the wall room only', async () => {
    const post = await createPost(cast.friend, cast.owner.user.id, 'Soon gone');
    const ownerSocket = await connect(cast.owner);
    const outsider = await connect(cast.stranger);
    await joinWall(ownerSocket, cast.owner.user.id);
    await joinWall(outsider, cast.stranger.user.id);
    const atOutsider = recordEvents(outsider, 'wall:post-deleted');
    const deleted = waitFor(ownerSocket, 'wall:post-deleted');

    expect((await cast.owner.agent.delete(`/api/posts/${String(post.id)}`)).status).toBe(204);

    await expect(deleted).resolves.toStrictEqual({ id: post.id, wallOwnerId: cast.owner.user.id });
    expect(atOutsider).toEqual([]);
  });

  it('a refused delete or post emits nothing', async () => {
    const post = await createPost(cast.owner, cast.owner.user.id, 'Stays');
    const ownerSocket = await connect(cast.owner);
    await joinWall(ownerSocket, cast.owner.user.id);
    const created = recordEvents(ownerSocket, 'wall:post-created');
    const removed = recordEvents(ownerSocket, 'wall:post-deleted');

    expect((await cast.stranger.agent.delete(`/api/posts/${String(post.id)}`)).status).toBe(403);
    expect((await cast.stranger.agent.post(postsPath(cast.owner.user.id)).send({ body: 'No' })).status).toBe(403);
    // Ordering marker: a permitted post arrives after anything the refused requests could have emitted.
    const marker = waitFor(ownerSocket, 'wall:post-created');
    const markerPost = await createPost(cast.owner, cast.owner.user.id, 'Marker');
    await marker;

    expect(created).toEqual([markerPost]);
    expect(removed).toEqual([]);
  });
});

describe('wall:leave', () => {
  it('stops the wall’s events for that socket and is ok even for a wall it never joined', async () => {
    const cast = await createWallCast(testApp);
    const friendSocket = await connect(cast.friend);
    const ownerSocket = await connect(cast.owner);
    await joinWall(friendSocket, cast.owner.user.id);
    await joinWall(ownerSocket, cast.owner.user.id);

    expect(await emitWall(friendSocket, 'wall:leave', { userId: cast.owner.user.id })).toStrictEqual({ ok: true });
    expect(await emitWall(friendSocket, 'wall:leave', { userId: cast.stranger.user.id })).toStrictEqual({ ok: true });
    expect(await isInWallRoom(cast.friend.user.id, cast.owner.user.id)).toBe(false);

    const atFriend = recordEvents(friendSocket, 'wall:post-created');
    const atOwner = waitFor(ownerSocket, 'wall:post-created');
    await createPost(cast.owner, cast.owner.user.id, 'After leave');
    await atOwner;
    expect(atFriend).toEqual([]);
  });
});

describe('session guard on wall:join (ADR-0005)', () => {
  it('a socket whose session is gone is acked unauthorized, disconnected and never joins', async () => {
    const user = await signedInUser(testApp);
    const socket = await connect(user);
    const [serverSocket] = await testApp.io.in(rooms.user(user.user.id)).fetchSockets();
    expect(serverSocket).toBeDefined();
    await testApp.redis.del(sessionKeyPrefix(testApp.prefix) + (serverSocket?.data.sessionId ?? ''));

    const closed = waitForDisconnect(socket);
    expect(await emitWall(socket, 'wall:join', { userId: user.user.id })).toStrictEqual({
      ok: false,
      error: { code: 'unauthorized', message: expect.any(String) as string },
    });
    expect(await closed).toBe('io server disconnect');
    expect(await isInWallRoom(user.user.id, user.user.id)).toBe(false);
  });
});

describe('wall:join rate limit (OVERVIEW §10: 30 per minute per user)', () => {
  let limitedApp: TestApp;

  beforeAll(async () => {
    limitedApp = await createTestApp({
      limits: {
        ...resolveLimits({ RATE_LIMIT_MULTIPLIER: TEST_RATE_LIMIT_MULTIPLIER }),
        wallJoin: { limit: 2, windowMs: 60_000 },
      },
    });
  });

  afterAll(async () => {
    await limitedApp.close();
  });

  it('acks rate-limited with retryAfterMs once the budget is spent, per user', async () => {
    const user = await signedInUser(limitedApp);
    const other = await signedInUser(limitedApp);
    const socket = await sockets.connect(limitedApp, user.agent);
    const otherSocket = await sockets.connect(limitedApp, other.agent);

    await joinWall(socket, user.user.id);
    await joinWall(socket, user.user.id);
    const limited = await emitWall(socket, 'wall:join', { userId: user.user.id });

    expect(limited).toStrictEqual({
      ok: false,
      error: {
        code: 'rate-limited',
        message: expect.any(String) as string,
        retryAfterMs: expect.any(Number) as number,
      },
    });
    expect(limited.ok ? 0 : (limited.error.retryAfterMs ?? 0)).toBeGreaterThan(0);
    expect(limited.ok ? 0 : (limited.error.retryAfterMs ?? 0)).toBeLessThanOrEqual(60_000);
    await joinWall(otherSocket, other.user.id);
  });
});
