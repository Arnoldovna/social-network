import { UserSummary } from '@app/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { insertUser, type UserRow } from '../../../../test/db.js';
import { signIn, type TestAgent } from '../../../../test/http.js';
import { connectAs, recordEvents, waitFor, type TestSocket } from '../../../../test/socket.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { rooms } from '../../../shared/realtime/rooms.js';
import { sessionKeyPrefix } from '../../../shared/security/session.js';

/**
 * Presence over real sockets (API.md §3, ADR-0009; F-86, F-87, F-88, F-90, F-91; B-19, B-43): the composed app with
 * the real handshake, the Redis store under this file's `test-<uuid>` prefix, and a grace period short enough to wait
 * for but long enough for a reconnect on a slow CI runner.
 *
 * "Not received" is never asserted after a sleep: a sentinel user's event that is emitted strictly later is awaited
 * first. Every socket gets its events in emit order, so whatever was emitted before the sentinel has arrived by then.
 */

const GRACE_MS = 1_000;

let testApp: TestApp;
const openSockets: TestSocket[] = [];

beforeAll(async () => {
  testApp = await createTestApp({ env: { PRESENCE_GRACE_MS: String(GRACE_MS) } });
});

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.close();
});

afterAll(async () => {
  await testApp.close();
});

interface Person {
  user: UserRow;
  agent: TestAgent;
}

async function person(fields: Parameters<typeof insertUser>[1] = {}): Promise<Person> {
  const user = await insertUser(testApp.db, fields);
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  return { user, agent };
}

async function open({ agent }: Person): Promise<TestSocket> {
  const socket = await connectAs(agent, testApp);
  openSockets.push(socket);
  return socket;
}

const joinedBy = (userId: number) => ({ filter: (user: UserSummary) => user.id === userId });
const leftBy = (userId: number) => ({ filter: (payload: { userId: number }) => payload.userId === userId });

/** Opens one socket for a new user and waits until `observer` has seen them join: the user is online now. */
async function onlineUser(observer: TestSocket): Promise<{ person: Person; socket: TestSocket }> {
  const someone = await person();
  const joined = waitFor(observer, 'presence:joined', joinedBy(someone.user.id));
  const socket = await open(someone);
  await joined;
  return { person: someone, socket };
}

/**
 * A sentinel user connects and disconnects; resolves once `observer` saw them leave. Their leave check was scheduled
 * after everything the test did before, so every earlier `left` (or `joined`) has reached `observer` by then.
 */
async function flushPresence(observer: TestSocket): Promise<void> {
  const { person: sentinel, socket } = await onlineUser(observer);
  const left = waitFor(observer, 'presence:left', { ...leftBy(sentinel.user.id), timeoutMs: GRACE_MS * 5 });
  socket.close();
  await left;
}

describe('presence:joined (F-88, F-90)', () => {
  it('reaches other users with exactly the public summary of the joining user (B-19)', async () => {
    const observer = await open(await person());
    const ada = await person({ firstName: 'Ada', avatar: true });

    const joined = waitFor(observer, 'presence:joined', joinedBy(ada.user.id));
    await open(ada);
    const payload = await joined;

    // Strict schema: an extra key such as `email` or `passwordHash` fails the parse.
    const { avatarUrl, ...rest } = UserSummary.parse(payload);
    expect(rest).toStrictEqual({ id: ada.user.id, firstName: 'Ada', lastName: ada.user.lastName });
    expect(avatarUrl).toMatch(new RegExp(`^/api/users/${String(ada.user.id)}/avatar\\?v=`));
    expect(JSON.stringify(payload)).not.toContain(ada.user.email);
  });

  it("never reaches the joining user's own sockets", async () => {
    const observer = await open(await person());
    const ada = await person();

    const joined = waitFor(observer, 'presence:joined', joinedBy(ada.user.id));
    const adaSocket = await open(ada);
    const heardByAda = recordEvents(adaSocket, 'presence:joined');
    await joined;
    // Ada hears the sentinel join, so her own join (emitted earlier) would have arrived before it.
    await flushPresence(adaSocket);

    expect(heardByAda.map((user) => user.id)).not.toContain(ada.user.id);
  });

  it('F-87: a second tab of the same user is announced once', async () => {
    const observer = await open(await person());
    const joins = recordEvents(observer, 'presence:joined');
    const { person: ada } = await onlineUser(observer);

    await open(ada);
    await flushPresence(observer);

    expect(joins.filter((user) => user.id === ada.user.id)).toHaveLength(1);
  });
});

describe('presence:left and the grace period (F-87, B-43)', () => {
  it('closing one of two tabs keeps the user online; closing the last one announces left after the grace period', async () => {
    const observer = await open(await person());
    const leaves = recordEvents(observer, 'presence:left');
    const { person: ada, socket: firstTab } = await onlineUser(observer);
    const secondTab = await open(ada);

    firstTab.close();
    await flushPresence(observer);
    expect(leaves.map(({ userId }) => userId)).not.toContain(ada.user.id);

    const left = waitFor(observer, 'presence:left', { ...leftBy(ada.user.id), timeoutMs: GRACE_MS * 5 });
    const closedAt = Date.now();
    secondTab.close();
    await expect(left).resolves.toStrictEqual({ userId: ada.user.id });
    // Node timers never fire early by more than a millisecond of rounding.
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(GRACE_MS - 5);
  });

  it('a reload within the grace period announces neither left nor a second join', async () => {
    const observer = await open(await person());
    const joins = recordEvents(observer, 'presence:joined');
    const leaves = recordEvents(observer, 'presence:left');
    const { person: ada, socket: tab } = await onlineUser(observer);

    tab.close();
    await open(ada);
    await flushPresence(observer);

    expect(joins.filter((user) => user.id === ada.user.id)).toHaveLength(1);
    expect(leaves.map(({ userId }) => userId)).not.toContain(ada.user.id);
  });

  it('a user whose session ended (sweep) stops counting as online (ADR-0005)', async () => {
    const observer = await open(await person());
    const { person: ada } = await onlineUser(observer);
    const [serverSocket] = await testApp.io.in(rooms.user(ada.user.id)).fetchSockets();
    if (!serverSocket) throw new Error('the server has no socket of the user');

    const left = waitFor(observer, 'presence:left', { ...leftBy(ada.user.id), timeoutMs: GRACE_MS * 5 });
    await testApp.redis.del(sessionKeyPrefix(testApp.prefix) + serverSocket.data.sessionId);
    await testApp.sessionGuard.sweep();

    await expect(left).resolves.toStrictEqual({ userId: ada.user.id });
  });
});

describe('Redis state (F-91)', () => {
  it('keeps one <instanceId>:<socketId> member per open socket in the user set', async () => {
    const observer = await open(await person());
    const { person: ada, socket: firstTab } = await onlineUser(observer);
    const secondTab = await open(ada);
    const key = `${testApp.prefix}:presence:sockets:${String(ada.user.id)}`;

    // The second tab is added by the server shortly after its `connect`; poll the shared state, never sleep.
    await expect.poll(() => testApp.redis.sCard(key)).toBe(2);
    const members = await testApp.redis.sMembers(key);
    const instanceIds = new Set(members.map((member) => member.split(':')[0]));
    expect(instanceIds.size).toBe(1);
    expect([...instanceIds][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(members.map((member) => member.slice(member.indexOf(':') + 1)).sort()).toStrictEqual(
      [firstTab.id, secondTab.id].sort(),
    );
    expect(await testApp.redis.sIsMember(`${testApp.prefix}:presence:online`, String(ada.user.id))).toBe(1);

    firstTab.close();
    await expect.poll(() => testApp.redis.sMembers(key)).toHaveLength(1);
  });
});
