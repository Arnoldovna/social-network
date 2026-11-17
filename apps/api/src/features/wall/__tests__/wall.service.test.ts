import { CreatePostBody, WallPage, WallPost } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { createFakeFriendshipReader, createFakePublisher } from '../../../../test/fakes.js';
import { UserNotFoundError, type AppError } from '../../../shared/errors/app-error.js';
import { createAvatarUrl } from '../../../shared/media/media-url.js';
import { encodeCursor } from '../../../shared/pagination/cursor.js';
import { rooms } from '../../../shared/realtime/rooms.js';
import {
  createWallService,
  PostDeleteForbiddenError,
  PostNotFoundError,
  WallForbiddenError,
  WallWriteForbiddenError,
} from '../wall.service.js';
import { createFakeWallRepository } from './fakes.js';
import { ADDRESSEE, at, FRIEND, FRIEND_OF_FRIEND, OWNER, REQUESTER, STRANGER, T0, userRow } from './fixtures.js';

/** A user id that no fixture creates. */
const UNKNOWN = 999;

function setup() {
  const repository = createFakeWallRepository({ now: () => T0 });
  repository.addUser(userRow(OWNER, { avatar: true }));
  for (const id of [FRIEND, REQUESTER, ADDRESSEE, STRANGER, FRIEND_OF_FRIEND]) repository.addUser(userRow(id));

  const friendships = createFakeFriendshipReader();
  friendships.set(FRIEND, OWNER, 'accepted');
  friendships.set(REQUESTER, OWNER, 'pending');
  friendships.set(OWNER, ADDRESSEE, 'pending');
  friendships.set(FRIEND_OF_FRIEND, FRIEND, 'accepted');

  const publisher = createFakePublisher();
  const avatarUrl = createAvatarUrl();
  const service = createWallService({ repository, friendships, publisher, avatarUrl });
  return { repository, friendships, publisher, avatarUrl, service };
}

const actor = (userId: number) => ({ userId });

/** Asserts the problem code as well as the class, so a wrong `ProblemCode` fails here and not only in the web app. */
async function expectAppError(promise: Promise<unknown>, type: new () => AppError, status: number): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(type);
  expect(error).toMatchObject({ status, code: new type().code });
}

describe('wall service: reading (F-65, B-23)', () => {
  it.each([
    ['the owner', OWNER],
    ['an accepted friend', FRIEND],
  ])('F-65: %s reads the wall', async (_who, viewer) => {
    const { service, repository } = setup();
    repository.addPost({ wallOwnerId: OWNER, authorId: FRIEND, body: 'Hello' });

    const page = await service.listPosts(actor(viewer), OWNER, { limit: 20 });

    expect(WallPage.parse(page).items.map(({ body }) => body)).toEqual(['Hello']);
  });

  it.each([
    ['a pending requester', REQUESTER],
    ['a pending addressee', ADDRESSEE],
    ['a stranger', STRANGER],
    ['a friend of a friend', FRIEND_OF_FRIEND],
  ])('B-23: %s gets wall-forbidden and no posts are read', async (_who, viewer) => {
    const { service, repository } = setup();
    repository.addPost({ wallOwnerId: OWNER, authorId: OWNER, body: 'Private' });

    await expectAppError(service.listPosts(actor(viewer), OWNER, { limit: 20 }), WallForbiddenError, 403);
    expect(repository.calls).not.toContain('listPosts');
  });

  it('F-65: an unknown wall owner is user-not-found before any friendship question', async () => {
    const { service, repository } = setup();
    await expectAppError(service.listPosts(actor(OWNER), UNKNOWN, { limit: 20 }), UserNotFoundError, 404);
    expect(repository.calls).toEqual(['userExists']);
  });

  it('rejects a malformed cursor with invalid-cursor (400) before touching the repository', async () => {
    const { service, repository } = setup();
    const error: unknown = await service.listPosts(actor(OWNER), OWNER, { limit: 20, cursor: 'not a cursor' }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ status: 400, code: 'invalid-cursor' });
    expect(repository.calls).toEqual([]);
  });

  it('F-69: maps rows to the strict WallPost DTO with the author summary and avatar URL', async () => {
    const { service, repository, avatarUrl } = setup();
    const owner = repository.users.get(OWNER);
    const post = repository.addPost({ wallOwnerId: OWNER, authorId: OWNER, body: 'Mine' });

    const { items } = await service.listPosts(actor(OWNER), OWNER, { limit: 20 });

    expect(items).toEqual([
      {
        id: post.id,
        wallOwnerId: OWNER,
        author: {
          id: OWNER,
          firstName: owner?.firstName,
          lastName: owner?.lastName,
          avatarUrl: avatarUrl(OWNER, owner?.avatarKey ?? null),
        },
        body: 'Mine',
        createdAt: T0.toISOString(),
      },
    ]);
    expect(items[0]?.author.avatarUrl).toMatch(/^\/api\/users\/1\/avatar\?v=[0-9a-f-]{36}$/);
    // Strict at every level: no avatar key, email or author id column leaks into the DTO (B-19).
    expect(() => WallPost.parse(items[0])).not.toThrow();
  });
});

describe('wall service: pagination (F-70, B-72, B-73)', () => {
  it('B-72: orders by createdAt DESC, then id DESC, independent of insertion order', async () => {
    const { service, repository } = setup();
    const older = repository.addPost({ wallOwnerId: OWNER, authorId: OWNER, body: 'older', createdAt: at(0) });
    const newest = repository.addPost({ wallOwnerId: OWNER, authorId: OWNER, body: 'newest', createdAt: at(2) });
    // Inserted last but written earlier than `newest`: time decides, not the id.
    const middle = repository.addPost({ wallOwnerId: OWNER, authorId: OWNER, body: 'middle', createdAt: at(1) });
    const tie = repository.addPost({ wallOwnerId: OWNER, authorId: OWNER, body: 'tie', createdAt: at(1) });

    const { items } = await service.listPosts(actor(OWNER), OWNER, { limit: 20 });

    expect(items.map(({ id }) => id)).toEqual([newest.id, tie.id, middle.id, older.id]);
  });

  it('B-73: pages through every post exactly once with an opaque cursor and ends with nextCursor null', async () => {
    const { service, repository } = setup();
    // 25 posts in the same millisecond, like one INSERT statement: only the id tie-breaker orders them (ADR-0014).
    const posts = Array.from({ length: 25 }, (_, index) =>
      repository.addPost({ wallOwnerId: OWNER, authorId: FRIEND, body: `Post ${String(index + 1)}` }),
    );

    const seen: number[] = [];
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.listPosts(actor(FRIEND), OWNER, { limit: 10, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map(({ id }) => id));
      pageSizes.push(page.items.length);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(pageSizes).toEqual([10, 10, 5]);
    expect(seen).toEqual(posts.map(({ id }) => id).reverse());
  });

  it('returns nextCursor null when the page is exactly full and nothing older exists', async () => {
    const { service, repository } = setup();
    for (let index = 0; index < 3; index++) repository.addPost({ wallOwnerId: OWNER, authorId: OWNER, body: 'x' });
    const page = await service.listPosts(actor(OWNER), OWNER, { limit: 3 });
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it('only lists the requested wall', async () => {
    const { service, repository } = setup();
    repository.addPost({ wallOwnerId: OWNER, authorId: OWNER, body: 'owner wall' });
    repository.addPost({ wallOwnerId: FRIEND, authorId: FRIEND, body: 'friend wall' });
    const { items } = await service.listPosts(actor(OWNER), OWNER, { limit: 20 });
    expect(items.map(({ body }) => body)).toEqual(['owner wall']);
  });

  it('accepts a well-formed cursor that points past every post (empty last page)', async () => {
    const { service, repository } = setup();
    repository.addPost({ wallOwnerId: OWNER, authorId: OWNER, body: 'x', createdAt: at(10) });
    const cursor = encodeCursor({ createdAt: at(0), id: 1 });
    expect(await service.listPosts(actor(OWNER), OWNER, { limit: 20, cursor })).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});

describe('wall service: posting (F-66, F-67, B-22, B-40, B-41)', () => {
  it.each([
    ['the owner on their own wall', OWNER],
    ['an accepted friend', FRIEND],
  ])('F-66: %s can post', async (_who, author) => {
    const { service, repository } = setup();
    const post = await service.createPost(actor(author), OWNER, { body: 'Hi there' });
    expect(post).toMatchObject({ wallOwnerId: OWNER, author: { id: author }, body: 'Hi there' });
    expect(repository.posts).toHaveLength(1);
  });

  it.each([
    ['a pending requester', REQUESTER],
    ['a pending addressee', ADDRESSEE],
    ['a stranger', STRANGER],
    ['a friend of a friend', FRIEND_OF_FRIEND],
  ])('B-22: %s gets wall-write-forbidden; nothing is stored or emitted', async (_who, author) => {
    const { service, repository, publisher } = setup();
    await expectAppError(service.createPost(actor(author), OWNER, { body: 'Spam' }), WallWriteForbiddenError, 403);
    expect(repository.posts).toEqual([]);
    expect(repository.calls).not.toContain('insertPost');
    expect(publisher.emits).toEqual([]);
  });

  it('B-22: posting on an unknown wall is user-not-found and stores nothing', async () => {
    const { service, repository, publisher } = setup();
    await expectAppError(service.createPost(actor(OWNER), UNKNOWN, { body: 'Hello?' }), UserNotFoundError, 404);
    expect(repository.posts).toEqual([]);
    expect(publisher.emits).toEqual([]);
  });

  it('B-41: the DTO carries the inserted row id (never the author id) and comes from the one insert call (B-75)', async () => {
    const { service, repository } = setup();
    const post = await service.createPost(actor(FRIEND), OWNER, { body: 'Fresh' });

    const [stored] = repository.posts;
    expect(post.id).toBe(stored?.id);
    expect(post.id).not.toBe(FRIEND);
    expect(post.createdAt).toBe(T0.toISOString());
    // The author comes back with the insert: no second lookup of the author or the post.
    expect(repository.calls.filter((call) => call === 'insertPost')).toHaveLength(1);
    expect(repository.calls).not.toContain('findPostOwnership');
  });

  it("B-40: emits wall:post-created with the returned DTO to the wall's room only", async () => {
    const { service, publisher } = setup();
    const post = await service.createPost(actor(FRIEND), OWNER, { body: 'Realtime' });
    expect(publisher.emits).toEqual([{ room: rooms.wall(OWNER), event: 'wall:post-created', args: [post] }]);
    expect(() => WallPost.parse(publisher.emitsOf('wall:post-created')[0]?.args[0])).not.toThrow();
  });

  it('F-67: the shared body schema trims and bounds a post to 1–2,000 characters', () => {
    expect(CreatePostBody.parse({ body: '  padded  ' })).toEqual({ body: 'padded' });
    expect(CreatePostBody.safeParse({ body: '   ' }).success).toBe(false);
    expect(CreatePostBody.safeParse({ body: 'x'.repeat(2000) }).success).toBe(true);
    expect(CreatePostBody.safeParse({ body: 'x'.repeat(2001) }).success).toBe(false);
  });
});

describe('wall service: deleting (F-71, B-21)', () => {
  it('F-71: the author deletes their own post on a friend’s wall and the wall room is told', async () => {
    const { service, repository, publisher } = setup();
    const post = repository.addPost({ wallOwnerId: OWNER, authorId: FRIEND, body: 'mine' });

    await service.deletePost(actor(FRIEND), post.id);

    expect(repository.posts).toEqual([]);
    // DATA-MODEL "Delete post": a permitted delete is the guarded statement alone, no lookup first (B-75).
    expect(repository.calls).toEqual(['deletePost']);
    expect(publisher.emits).toEqual([
      { room: rooms.wall(OWNER), event: 'wall:post-deleted', args: [{ id: post.id, wallOwnerId: OWNER }] },
    ]);
  });

  it('F-71: the wall owner deletes a friend’s post on their wall', async () => {
    const { service, repository } = setup();
    const post = repository.addPost({ wallOwnerId: OWNER, authorId: FRIEND, body: 'from a friend' });
    await service.deletePost(actor(OWNER), post.id);
    expect(repository.posts).toEqual([]);
  });

  it.each([
    ['a friend of the owner who is not the author', FRIEND, OWNER],
    ['a stranger', STRANGER, OWNER],
    ['the owner of another wall', REQUESTER, OWNER],
  ])('B-21: %s gets post-delete-forbidden; the post stays', async (_who, deleter, author) => {
    const { service, repository, publisher } = setup();
    const post = repository.addPost({ wallOwnerId: OWNER, authorId: author, body: 'keep me' });

    await expectAppError(service.deletePost(actor(deleter), post.id), PostDeleteForbiddenError, 403);

    expect(repository.posts.map(({ id }) => id)).toEqual([post.id]);
    // The guarded delete matched nothing; only then the lookup decides 403 over 404.
    expect(repository.calls).toEqual(['deletePost', 'findPostOwnership']);
    expect(publisher.emits).toEqual([]);
  });

  it('B-21: an unknown post is post-not-found', async () => {
    const { service, publisher } = setup();
    await expectAppError(service.deletePost(actor(OWNER), 4242), PostNotFoundError, 404);
    expect(publisher.emits).toEqual([]);
  });

  it('a post that is already gone (e.g. deleted by the other permitted user) is post-not-found, without an emit', async () => {
    const { service, repository, publisher } = setup();
    const post = repository.addPost({ wallOwnerId: OWNER, authorId: FRIEND, body: 'racing' });
    await service.deletePost(actor(OWNER), post.id);
    publisher.clear();

    await expectAppError(service.deletePost(actor(FRIEND), post.id), PostNotFoundError, 404);
    expect(publisher.emits).toEqual([]);
  });
});

describe('wall service: wall:join permission (B-23, B-39)', () => {
  it.each([
    ['the owner', OWNER],
    ['an accepted friend', FRIEND],
  ])('%s may join', async (_who, viewer) => {
    const { service } = setup();
    await expect(service.assertCanView(actor(viewer), OWNER)).resolves.toBeUndefined();
  });

  it.each([
    ['a pending requester', REQUESTER],
    ['a pending addressee', ADDRESSEE],
    ['a stranger', STRANGER],
  ])('B-39: %s is forbidden', async (_who, viewer) => {
    const { service } = setup();
    await expectAppError(service.assertCanView(actor(viewer), OWNER), WallForbiddenError, 403);
  });

  it('an unknown user is user-not-found', async () => {
    const { service } = setup();
    await expectAppError(service.assertCanView(actor(OWNER), UNKNOWN), UserNotFoundError, 404);
  });

  it('follows an unfriend immediately: no friendship state is cached', async () => {
    const { service, friendships } = setup();
    await service.assertCanView(actor(FRIEND), OWNER);
    friendships.remove(FRIEND, OWNER);
    await expectAppError(service.assertCanView(actor(FRIEND), OWNER), WallForbiddenError, 403);
  });
});
