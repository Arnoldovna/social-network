import { randomUUID } from 'node:crypto';

import { PresenceResponse, Problem, problemCode } from '@app/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { insertUser, type InsertUserFields, type UserRow } from '../../../../test/db.js';
import { signIn, type TestAgent } from '../../../../test/http.js';
import { connectAs, type TestSocket } from '../../../../test/socket.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';

/**
 * `GET /api/presence` (API.md "Presence"; F-86, F-87, F-90; B-19, B-44, B-46) on the composed app. Presence comes
 * from real sockets; the request has no params, query or body, so there is no 400 case, and it is a read, so there is
 * neither a CSRF nor an ownership case.
 */

const GRACE_MS = 200;

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

async function person(app: TestApp, fields: InsertUserFields = {}): Promise<Person> {
  const user = await insertUser(app.db, fields);
  const agent = request.agent(app.app);
  await signIn(agent, user.id);
  return { user, agent };
}

async function open(app: TestApp, { agent }: Person): Promise<TestSocket> {
  const socket = await connectAs(agent, app);
  openSockets.push(socket);
  return socket;
}

async function presenceOf(agent: TestAgent): Promise<PresenceResponse> {
  const response = await agent.get('/api/presence').expect(200);
  return PresenceResponse.parse(response.body);
}

/** The listed ids among `ids`, in response order (other tests of this file share the app). */
async function listed(agent: TestAgent, ids: readonly number[]): Promise<number[]> {
  const { items } = await presenceOf(agent);
  return items.map((user) => user.id).filter((id) => ids.includes(id));
}

/** Connected sockets are added right after the handshake; poll the response instead of sleeping. */
async function expectListed(agent: TestAgent, ids: readonly number[], expected: readonly number[]): Promise<void> {
  await expect.poll(() => listed(agent, ids)).toStrictEqual(expected);
}

describe('GET /api/presence', () => {
  it('401 problem+json for a visitor', async () => {
    const response = await request(testApp.app).get('/api/presence').expect(401);

    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    const problem = Problem.parse(response.body);
    expect(problem).toMatchObject({ status: 401, instance: '/api/presence' });
    expect(problemCode(problem)).toBe('unauthorized');
  });

  it('B-46: an empty list when only the viewer is online, never the viewer themselves', async () => {
    const viewer = await person(testApp);
    await open(testApp, viewer);
    await expect
      .poll(() => testApp.redis.sIsMember(`${testApp.prefix}:presence:online`, String(viewer.user.id)))
      .toBe(1);

    expect(await listed(viewer.agent, [viewer.user.id])).toStrictEqual([]);
  });

  it('F-86, F-90: every other connected user once, public fields only, ordered by name', async () => {
    const suffix = randomUUID().slice(0, 8);
    const viewer = await person(testApp);
    const bea = await person(testApp, { firstName: 'Bea', lastName: `Online-${suffix}` });
    const adam = await person(testApp, { firstName: 'adam', lastName: `Online-${suffix}`, avatar: true });
    const carl = await person(testApp, { firstName: 'Carl', lastName: `Online-${suffix}` });
    const offline = await person(testApp, { firstName: 'Aaron', lastName: `Offline-${suffix}` });
    await open(testApp, viewer);
    await open(testApp, bea);
    await open(testApp, bea); // a second tab is still one entry
    await open(testApp, carl);
    await open(testApp, adam);
    const ids = [viewer, bea, adam, carl, offline].map(({ user }) => user.id);

    // Case-insensitive name order; the signed-in user without a socket is not online.
    await expectListed(viewer.agent, ids, [adam.user.id, bea.user.id, carl.user.id]);

    const response = await viewer.agent.get('/api/presence').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const { items } = PresenceResponse.parse(response.body);
    const listedAdam = items.find((user) => user.id === adam.user.id);
    if (!listedAdam) throw new Error('adam is not listed');
    const { avatarUrl, ...rest } = listedAdam;
    expect(rest).toStrictEqual({ id: adam.user.id, firstName: 'adam', lastName: adam.user.lastName });
    expect(avatarUrl).toMatch(new RegExp(`^/api/users/${String(adam.user.id)}/avatar\\?v=`));
    // B-19: no private column of any listed user reaches the response.
    for (const { user } of [bea, adam, carl]) {
      expect(response.text).not.toContain(user.email);
      expect(response.text).not.toContain(user.passwordHash);
    }
  });

  it('F-87: a user stays listed during the grace period and disappears after it', async () => {
    const viewer = await person(testApp);
    const ada = await person(testApp);
    const socket = await open(testApp, ada);
    await expectListed(viewer.agent, [ada.user.id], [ada.user.id]);

    socket.close();
    await expectListed(viewer.agent, [ada.user.id], []);
  });

  it('works without a socket of the viewer and ignores query parameters', async () => {
    const viewer = await person(testApp);
    const ada = await person(testApp);
    await open(testApp, ada);

    await expect
      .poll(async () => {
        const response = await viewer.agent.get('/api/presence?limit=1&userId=1').expect(200);
        return PresenceResponse.parse(response.body).items.some((user) => user.id === ada.user.id);
      })
      .toBe(true);
  });
});

describe('boot cleanup (B-44, ADR-0009)', () => {
  it('a restarted app forgets the presence of every socket from before the restart', async () => {
    const keyPrefix = `test-${randomUUID()}`;
    const ghost = await insertUser(testApp.db);
    // What a crashed process would leave behind in its namespace.
    await testApp.redis.sAdd(`${keyPrefix}:presence:online`, String(ghost.id));
    await testApp.redis.sAdd(`${keyPrefix}:presence:sockets:${String(ghost.id)}`, 'old-instance:old-socket');

    const restarted = await createTestApp({ keyPrefix });
    try {
      const viewer = await person(restarted);
      expect((await presenceOf(viewer.agent)).items.map((user) => user.id)).not.toContain(ghost.id);
      expect(await restarted.redis.keys(`${keyPrefix}:presence:sockets:*`)).toStrictEqual([]);
    } finally {
      await restarted.close();
    }
  });
});
