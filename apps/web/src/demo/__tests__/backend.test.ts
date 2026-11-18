import { ChatPage, FriendshipsResponse, MeResponse, PAGE_LIMIT_DEFAULT } from '@app/shared';
import { CHAT, PEOPLE, WALLS } from '@app/shared/demo-seed';
import { describe, expect, it } from 'vitest';

import { DemoProblem } from '../problem';
import { buildSeedState, loadOrSeed } from '../seed';
import { DEMO_PASSWORD } from '../state';
import { createTestBackend, fakeUuid, MIRA_EMAIL, NOW } from './fakes';

/** Ids in seed order (DATA-MODEL.md): the same ids a fresh database gives the demo people. */
const MIRA = 1;
const TOMAS = 2;
const NOAH = 4;
const SOFIA = 9;
const CLARA = 11;

async function signedInAsMira() {
  const test = await createTestBackend();
  await test.backend.login({ email: MIRA_EMAIL, password: DEMO_PASSWORD });
  return test;
}

/** The problem a call fails with, for assertions on status, code and field errors. */
async function problemOf(action: () => unknown): Promise<DemoProblem> {
  try {
    await action();
  } catch (error) {
    if (error instanceof DemoProblem) return error;
    throw error;
  }
  throw new Error('expected a DemoProblem, but the call succeeded');
}

describe('demo seed (ADR-0020: the same data as `pnpm db:seed`)', () => {
  it('holds the 14 people, the friendship graph, the walls and the chat in insertion order', async () => {
    const state = await buildSeedState(NOW, fakeUuid);

    expect(state.users.map((user) => user.email)).toEqual(PEOPLE.map((person) => person.email));
    expect(state.users[0]).toMatchObject({ id: MIRA, firstName: 'Mira', lastName: 'Novak' });
    expect(state.friendships).toHaveLength(13);
    expect(state.posts).toHaveLength(WALLS.reduce((sum, wall) => sum + wall.posts.length, 0));
    expect(state.messages.map((message) => message.body)).toEqual(CHAT.map((message) => message.body));
    expect(state.sessionUserId).toBeNull();
    // Generated designs for the people with an avatar, the initials fallback for the others.
    expect(state.users.filter((user) => user.avatar?.kind === 'design')).toHaveLength(
      PEOPLE.filter((person) => person.avatar).length,
    );
    // No password in clear text.
    expect(JSON.stringify(state)).not.toContain(DEMO_PASSWORD);
  });

  it('dates everything in the past and draws the same avatar designs for the same seed', async () => {
    const first = await buildSeedState(NOW, fakeUuid);
    const second = await buildSeedState(NOW, fakeUuid);

    const designs = (state: typeof first) =>
      state.users.map((user) => (user.avatar?.kind === 'design' ? user.avatar.design : null));
    expect(designs(second)).toEqual(designs(first));
    const newest = Math.max(...first.messages.map((message) => Date.parse(message.createdAt)));
    expect(newest).toBeLessThan(NOW.getTime());
  });
});

describe('demo backend: session, CSRF and auth', () => {
  it('logs in with the demo password, keeps the session in the stored state and answers GET /me', async () => {
    const { backend, persistence } = await createTestBackend();

    const auth = await backend.login({ email: 'Mira.Novak@example.com ', password: DEMO_PASSWORD });

    expect(auth.user).toMatchObject({ id: MIRA, firstName: 'Mira' });
    expect(MeResponse.parse(backend.me()).user.id).toBe(MIRA);
    expect((await persistence.load())?.sessionUserId).toBe(MIRA);
    // Login regenerates the session: the response carries the new CSRF token, which then protects mutations.
    expect(() => {
      backend.assertCsrf(auth.csrfToken);
    }).not.toThrow();
  });

  it('answers an unknown email and a wrong password alike (F-15) and a visitor with 401', async () => {
    const { backend } = await createTestBackend();

    const unknown = await problemOf(() => backend.login({ email: 'nobody@example.com', password: DEMO_PASSWORD }));
    const wrong = await problemOf(() => backend.login({ email: MIRA_EMAIL, password: 'not the password' }));

    expect([unknown.status, unknown.code, unknown.detail]).toEqual([wrong.status, wrong.code, wrong.detail]);
    expect(wrong.code).toBe('invalid-credentials');
    expect((await problemOf(() => backend.me())).status).toBe(401);
  });

  it('validates registration with the shared contract: 422 with field errors, 409 for a taken email', async () => {
    const { backend } = await createTestBackend();

    const invalid = await problemOf(() =>
      backend.register({ firstName: ' ', lastName: 'Example', email: 'not-an-email', password: 'short' }),
    );
    expect(invalid).toMatchObject({ status: 422, code: 'validation-failed' });
    expect(invalid.errors?.map((error) => error.path).sort()).toEqual(['email', 'firstName', 'password']);
    expect(invalid.errors?.find((error) => error.path === 'password')?.message).toBe('Use at least 12 characters.');

    const taken = await problemOf(() =>
      backend.register({ firstName: 'Mira', lastName: 'Again', email: MIRA_EMAIL, password: 'a long enough password' }),
    );
    expect(taken).toMatchObject({ status: 409, code: 'email-taken' });
    expect(taken.errors?.[0]?.path).toBe('email');
  });

  it('registers a new member with the next id and signs them in', async () => {
    const { backend } = await createTestBackend();

    const auth = await backend.register({
      firstName: 'Lena',
      lastName: 'Visitor',
      email: 'lena@example.com',
      password: 'a long enough password',
    });

    expect(auth.user).toMatchObject({ id: PEOPLE.length + 1, bio: null, avatarUrl: null });
    expect(backend.sessionUserId()).toBe(PEOPLE.length + 1);
  });

  it('refuses unsafe requests without the session token (403 csrf-invalid, F-23)', async () => {
    const { backend } = await signedInAsMira();

    expect(() => {
      backend.assertCsrf(null);
    }).toThrow(expect.objectContaining({ status: 403, code: 'csrf-invalid' }) as Error);
    expect(() => {
      backend.assertCsrf('forged');
    }).toThrow(DemoProblem);
  });

  it('logs out: the session and its CSRF token are gone, its sockets are closed (F-20)', async () => {
    const { backend, realtime } = await signedInAsMira();
    const token = backend.csrfToken().token;

    await backend.logout();

    expect(realtime.roomChanges).toEqual([`session of ${String(MIRA)} ended`]);

    expect(backend.sessionUserId()).toBeNull();
    expect(() => {
      backend.assertCsrf(token);
    }).toThrow(DemoProblem);
  });
});

describe('demo backend: friendships, walls and chat', () => {
  it('lists Mira’s friends, incoming and outgoing requests from the seed', async () => {
    const { backend } = await signedInAsMira();

    const friendships = FriendshipsResponse.parse(backend.friendships());

    expect(friendships.friends.map((entry) => entry.user.firstName)).toEqual([
      'Aiko',
      'Amara',
      'Jonas',
      'Priya',
      'Tomás',
    ]);
    expect(friendships.incoming.map((entry) => entry.user.id)).toEqual([SOFIA, 10]);
    expect(friendships.outgoing.map((entry) => entry.user.id)).toEqual([CLARA]);
  });

  it('sends a friend request and tells both people (F-52); a second one is a 409, oneself a 422', async () => {
    const { backend, realtime } = await signedInAsMira();

    const change = await backend.sendFriendRequest({ userId: NOAH });

    expect(change).toEqual({ userId: NOAH, state: 'pending_outgoing' });
    expect(realtime.events).toEqual([
      { target: { kind: 'user', userId: MIRA }, event: 'friendship:changed', args: [change] },
      {
        target: { kind: 'user', userId: NOAH },
        event: 'friendship:changed',
        args: [{ userId: MIRA, state: 'pending_incoming' }],
      },
    ]);
    expect(await problemOf(() => backend.sendFriendRequest({ userId: NOAH }))).toMatchObject({
      status: 409,
      code: 'friendship-exists',
    });
    expect(await problemOf(() => backend.sendFriendRequest({ userId: MIRA }))).toMatchObject({
      status: 422,
      code: 'cannot-befriend-self',
    });
    // JSON numbers only, no coercion (API.md conventions).
    expect(await problemOf(() => backend.sendFriendRequest({ userId: String(NOAH) }))).toMatchObject({ status: 422 });
  });

  it('accepts only an incoming request; the requester cannot accept their own (404)', async () => {
    const { backend } = await signedInAsMira();

    expect(await backend.acceptFriendRequest(String(SOFIA))).toEqual({ userId: SOFIA, state: 'friends' });
    expect(await problemOf(() => backend.acceptFriendRequest(String(CLARA)))).toMatchObject({
      status: 404,
      code: 'friend-request-not-found',
    });
  });

  it('takes both people out of each other’s wall rooms on unfriend, not on a declined request (B-39)', async () => {
    const { backend, realtime } = await signedInAsMira();

    await backend.removeFriendship(String(TOMAS));
    await backend.removeFriendship(String(SOFIA));

    expect(realtime.roomChanges).toEqual([
      `${String(MIRA)} leaves wall ${String(TOMAS)}`,
      `${String(TOMAS)} leaves wall ${String(MIRA)}`,
    ]);
    expect(backend.profile(String(TOMAS)).relationship.canViewWall).toBe(false);
  });

  it('keeps walls friends-only (F-65, F-66) and posts to the wall room (F-72)', async () => {
    const { backend, realtime } = await signedInAsMira();

    expect(await problemOf(() => backend.wall(String(NOAH), {}))).toMatchObject({
      status: 403,
      code: 'wall-forbidden',
    });
    expect(await problemOf(() => backend.createPost(String(NOAH), { body: 'hello' }))).toMatchObject({
      status: 403,
      code: 'wall-write-forbidden',
    });
    expect(await problemOf(() => backend.wall('abc', {}))).toMatchObject({ status: 400, code: 'invalid-request' });
    expect(await problemOf(() => backend.wall('999', {}))).toMatchObject({ status: 404, code: 'user-not-found' });

    const { post } = await backend.createPost(String(TOMAS), { body: '  Bread on Friday?  ' });

    expect(post).toMatchObject({ wallOwnerId: TOMAS, body: 'Bread on Friday?', author: { id: MIRA } });
    expect(backend.wall(String(TOMAS), {}).items[0]?.id).toBe(post.id);
    expect(realtime.events.at(-1)).toEqual({
      target: { kind: 'wall', ownerId: TOMAS },
      event: 'wall:post-created',
      args: [post],
    });
  });

  it('lets the wall owner and the author delete a post, nobody else (F-71)', async () => {
    const { backend, state } = await signedInAsMira();
    const onTomasWallByTomas = state.posts.find((post) => post.wallOwnerId === TOMAS && post.authorId === TOMAS);
    const onMiraWallByTomas = state.posts.find((post) => post.wallOwnerId === MIRA && post.authorId === TOMAS);
    if (onTomasWallByTomas === undefined || onMiraWallByTomas === undefined) throw new Error('seed changed');

    expect(await problemOf(() => backend.deletePost(String(onTomasWallByTomas.id)))).toMatchObject({
      status: 403,
      code: 'post-delete-forbidden',
    });
    await backend.deletePost(String(onMiraWallByTomas.id));
    expect(state.posts.some((post) => post.id === onMiraWallByTomas.id)).toBe(false);
  });

  it('pages the chat newest first with a cursor (F-76, F-82) and rejects a broken cursor', async () => {
    const { backend } = await signedInAsMira();

    const first = ChatPage.parse(backend.chat({}));
    expect(first.items).toHaveLength(PAGE_LIMIT_DEFAULT);
    expect(first.items[0]?.body).toBe(CHAT.at(-1)?.body);
    const second = backend.chat({ cursor: first.nextCursor ?? '' });
    expect(second.items[0]?.id).toBe((first.items.at(-1)?.id ?? 0) - 1);
    expect(await problemOf(() => backend.chat({ cursor: 'garbage' }))).toMatchObject({ code: 'invalid-cursor' });
    expect(await problemOf(() => backend.chat({ limit: '1e1' }))).toMatchObject({ status: 400 });
  });

  it('stores a chat message with the next id and sends it to every socket', async () => {
    const { backend, realtime } = await signedInAsMira();

    const message = await backend.sendChat({ body: ' Anyone at the market? ' });

    expect(message).toMatchObject({ id: CHAT.length + 1, body: 'Anyone at the market?', author: { id: MIRA } });
    expect(realtime.events.at(-1)).toEqual({ target: { kind: 'all' }, event: 'chat:message', args: [message] });
    expect(await problemOf(() => backend.sendChat({ body: '   ' }))).toMatchObject({ code: 'validation-failed' });
  });

  it('serves seeded avatars as SVG and checks uploads like the API (415, 413, 422)', async () => {
    const { backend } = await signedInAsMira();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

    const seeded = await backend.avatar(String(MIRA));
    expect(seeded.contentType).toBe('image/svg+xml');
    expect(seeded.body).toContain('<svg');

    const notAnImage = new FormData();
    notAnImage.set('avatar', new Blob(['plain text']));
    expect(await problemOf(() => backend.uploadAvatar(notAnImage))).toMatchObject({ status: 415 });

    const tooLarge = new FormData();
    tooLarge.set('avatar', new Blob([png, new Uint8Array(2 * 1024 * 1024)]));
    expect(await problemOf(() => backend.uploadAvatar(tooLarge))).toMatchObject({ status: 413 });

    expect(await problemOf(() => backend.uploadAvatar(new FormData()))).toMatchObject({ code: 'file-required' });

    const upload = new FormData();
    upload.set('avatar', new Blob([png]));
    const { user } = await backend.uploadAvatar(upload);
    expect(user.avatarUrl).toMatch(/^\/api\/users\/1\/avatar\?v=[0-9a-f-]{36}$/);
    const stored = await backend.avatar(String(MIRA));
    expect(stored.contentType).toBe('image/png');
  });

  it('refuses an image beyond the pixel limits (422, location file)', async () => {
    const { backend } = await createTestBackend({
      measureImage: () => Promise.resolve({ width: 9000, height: 10 }),
    });
    await backend.login({ email: MIRA_EMAIL, password: DEMO_PASSWORD });
    const upload = new FormData();
    upload.set('avatar', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])]));

    const problem = await problemOf(() => backend.uploadAvatar(upload));

    expect(problem).toMatchObject({ status: 422, code: 'validation-failed' });
    expect(problem.errors?.[0]?.location).toBe('file');
  });
});

describe('demo reset (the banner\'s "reset demo data")', () => {
  it('clears the stored state and avatars, so the next start seeds afresh without the visitor’s changes', async () => {
    const { backend, persistence } = await signedInAsMira();
    const post = 'A post that the reset removes.';
    await backend.createPost(String(MIRA), { body: post });
    const upload = new FormData();
    upload.set('avatar', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])]));
    await backend.uploadAvatar(upload);
    // Before the reset, the next start continues where the visitor left off.
    expect((await loadOrSeed(persistence, NOW)).posts.some((row) => row.body === post)).toBe(true);

    await persistence.clear();

    expect(await persistence.loadAvatar(MIRA)).toBeUndefined();
    const fresh = await loadOrSeed(persistence, NOW);
    expect(fresh.posts.some((row) => row.body === post)).toBe(false);
    expect(fresh.sessionUserId).toBeNull();
    expect(fresh.users.find((user) => user.id === MIRA)?.avatar?.kind).toBe('design');
    // The fresh seed is stored at once, so a reload keeps it.
    expect((await persistence.load())?.posts).toHaveLength(fresh.posts.length);
  });
});
