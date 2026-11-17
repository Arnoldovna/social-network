import { FriendshipChange, FriendshipsResponse, FriendshipState, ProblemCode } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { createFakeClock, createFakePublisher } from '../../../../test/fakes.js';
import { UserNotFoundError, type AppError } from '../../../shared/errors/app-error.js';
import { createAvatarUrl, newAvatarKey } from '../../../shared/media/media-url.js';
import { rooms } from '../../../shared/realtime/rooms.js';
import {
  CannotBefriendSelfError,
  createFriendsService,
  FriendRequestNotFoundError,
  FriendshipExistsError,
  FriendshipNotFoundError,
} from '../friends.service.js';
import { createFakeFriendsRepository } from './fakes.js';

const MIRA = 1;
const JONAS = 2;
const ADA = 3;
const UNKNOWN = 99;

function setup() {
  const clock = createFakeClock();
  const repository = createFakeFriendsRepository({ now: () => clock.now() });
  const publisher = createFakePublisher();
  const service = createFriendsService({ repository, publisher, avatarUrl: createAvatarUrl() });
  repository.addUser({ id: MIRA, firstName: 'Mira', lastName: 'Okafor' });
  repository.addUser({ id: JONAS, firstName: 'Jonas', lastName: 'Berg' });
  repository.addUser({ id: ADA, firstName: 'Ada', lastName: 'Lind' });
  return { clock, repository, publisher, service };
}

const as = (userId: number) => ({ userId });

/** The `friendship:changed` emits as `[room, payload]`, in call order. */
function changes(publisher: ReturnType<typeof createFakePublisher>): [string, FriendshipChange][] {
  return publisher.emitsOf('friendship:changed').map(({ room, args }) => [room, args[0]]);
}

describe('friends service: sendRequest (POST /api/friendships)', () => {
  it('F-46, B-52: creates a pending row requester → addressee and answers pending_outgoing', async () => {
    const { service, repository } = setup();

    const change = await service.sendRequest(as(MIRA), JONAS);

    expect(FriendshipChange.parse(change)).toEqual({ userId: JONAS, state: 'pending_outgoing' });
    expect(repository.rowOf(MIRA, JONAS)).toMatchObject({ requesterId: MIRA, addresseeId: JONAS, status: 'pending' });
  });

  it('F-52, F-57: emits friendship:changed to both users, each from their own point of view', async () => {
    const { service, publisher } = setup();

    await service.sendRequest(as(MIRA), JONAS);

    expect(changes(publisher)).toEqual([
      [rooms.user(MIRA), { userId: JONAS, state: 'pending_outgoing' }],
      [rooms.user(JONAS), { userId: MIRA, state: 'pending_incoming' }],
    ]);
    expect(publisher.leaves).toEqual([]);
  });

  it('B-24: a request to oneself is 422 cannot-befriend-self before any query', async () => {
    const { service, repository, publisher } = setup();

    const error = await service.sendRequest(as(MIRA), MIRA).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CannotBefriendSelfError);
    expect(error).toMatchObject({ status: 422, code: 'cannot-befriend-self' });
    expect(repository.calls).toEqual([]);
    expect(repository.rows.size).toBe(0);
    expect(publisher.emits).toEqual([]);
  });

  it('B-24: a request to a user that does not exist is 404 user-not-found and writes nothing', async () => {
    const { service, repository, publisher } = setup();

    await expect(service.sendRequest(as(MIRA), UNKNOWN)).rejects.toMatchObject({
      status: 404,
      code: 'user-not-found',
    });
    expect(repository.calls).toEqual(['userExists']);
    expect(publisher.emits).toEqual([]);
  });

  it.each([
    ['an own pending request', MIRA, JONAS, 'pending'],
    ['a pending request in the other direction', JONAS, MIRA, 'pending'],
    ['an accepted friendship', JONAS, MIRA, 'accepted'],
  ] as const)('F-46, B-25: is 409 friendship-exists for %s, and the row is unchanged', async (_, from, to, status) => {
    const { service, repository, publisher } = setup();
    const before = { ...repository.seed(from, to, status) };

    await expect(service.sendRequest(as(MIRA), JONAS)).rejects.toBeInstanceOf(FriendshipExistsError);
    await expect(service.sendRequest(as(MIRA), JONAS)).rejects.toMatchObject({
      status: 409,
      code: 'friendship-exists',
    });
    expect(repository.rows.size).toBe(1);
    expect(repository.rowOf(MIRA, JONAS)).toEqual(before);
    expect(publisher.emits).toEqual([]);
  });

  it('F-51: repeated clicks leave exactly one row', async () => {
    const { service, repository } = setup();

    const results = await Promise.allSettled([
      service.sendRequest(as(MIRA), JONAS),
      service.sendRequest(as(MIRA), JONAS),
      service.sendRequest(as(JONAS), MIRA),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(repository.rows.size).toBe(1);
  });
});

describe('friends service: accept (POST /api/friendships/:userId/accept)', () => {
  it('F-48: the addressee accepts a pending request; both sides become friends', async () => {
    const { service, repository, publisher, clock } = setup();
    repository.seed(MIRA, JONAS, 'pending');
    const acceptedAt = clock.advance(60_000);

    const change = await service.accept(as(JONAS), MIRA);

    expect(FriendshipChange.parse(change)).toEqual({ userId: MIRA, state: 'friends' });
    expect(repository.rowOf(MIRA, JONAS)).toMatchObject({ status: 'accepted', acceptedAt });
    expect(changes(publisher)).toEqual([
      [rooms.user(JONAS), { userId: MIRA, state: 'friends' }],
      [rooms.user(MIRA), { userId: JONAS, state: 'friends' }],
    ]);
  });

  it('F-48, B-26: the requester cannot accept their own request (404, row stays pending, no event)', async () => {
    const { service, repository, publisher } = setup();
    repository.seed(MIRA, JONAS, 'pending');

    await expect(service.accept(as(MIRA), JONAS)).rejects.toBeInstanceOf(FriendRequestNotFoundError);
    expect(repository.rowOf(MIRA, JONAS)).toMatchObject({ status: 'pending', acceptedAt: null });
    expect(publisher.emits).toEqual([]);
  });

  it('B-26: accepting a request that does not exist is 404 friend-request-not-found, never "friends"', async () => {
    const { service, publisher } = setup();

    await expect(service.accept(as(JONAS), MIRA)).rejects.toMatchObject({
      status: 404,
      code: 'friend-request-not-found',
    });
    await expect(service.accept(as(JONAS), UNKNOWN)).rejects.toBeInstanceOf(FriendRequestNotFoundError);
    expect(publisher.emits).toEqual([]);
  });

  it('B-26: accepting an already accepted friendship is 404 and keeps the original acceptedAt', async () => {
    const { service, repository, clock } = setup();
    const { acceptedAt } = repository.seed(MIRA, JONAS, 'accepted');
    clock.advance(60_000);

    await expect(service.accept(as(JONAS), MIRA)).rejects.toBeInstanceOf(FriendRequestNotFoundError);
    expect(repository.rowOf(MIRA, JONAS)?.acceptedAt).toEqual(acceptedAt);
  });

  it('accepting oneself is 404 without a query', async () => {
    const { service, repository } = setup();

    await expect(service.accept(as(MIRA), MIRA)).rejects.toBeInstanceOf(FriendRequestNotFoundError);
    expect(repository.calls).toEqual([]);
  });
});

describe('friends service: remove (DELETE /api/friendships/:userId)', () => {
  it('F-47: the requester cancels a pending request', async () => {
    const { service, repository, publisher } = setup();
    repository.seed(MIRA, JONAS, 'pending');

    const change = await service.remove(as(MIRA), JONAS);

    expect(FriendshipChange.parse(change)).toEqual({ userId: JONAS, state: 'none' });
    expect(repository.rowOf(MIRA, JONAS)).toBeUndefined();
    expect(changes(publisher)).toEqual([
      [rooms.user(MIRA), { userId: JONAS, state: 'none' }],
      [rooms.user(JONAS), { userId: MIRA, state: 'none' }],
    ]);
    expect(publisher.leaves).toEqual([]);
  });

  it('F-49, B-27: the addressee declines a pending request', async () => {
    const { service, repository, publisher } = setup();
    repository.seed(MIRA, JONAS, 'pending');

    await expect(service.remove(as(JONAS), MIRA)).resolves.toEqual({ userId: MIRA, state: 'none' });
    expect(repository.rowOf(MIRA, JONAS)).toBeUndefined();
    expect(publisher.leaves).toEqual([]);
  });

  it.each([
    ['the requester', MIRA, JONAS],
    ['the addressee', JONAS, MIRA],
  ])('F-50: %s ends an accepted friendship and both leave each other’s wall room', async (_, actor, other) => {
    const { service, repository, publisher } = setup();
    repository.seed(MIRA, JONAS, 'accepted');

    await expect(service.remove(as(actor), other)).resolves.toEqual({ userId: other, state: 'none' });

    expect(repository.rowOf(MIRA, JONAS)).toBeUndefined();
    expect(publisher.leaves).toEqual([
      { socketsInRoom: rooms.user(actor), room: rooms.wall(other) },
      { socketsInRoom: rooms.user(other), room: rooms.wall(actor) },
    ]);
    expect(changes(publisher)).toEqual([
      [rooms.user(actor), { userId: other, state: 'none' }],
      [rooms.user(other), { userId: actor, state: 'none' }],
    ]);
  });

  it('is 404 friendship-not-found when the pair has no row', async () => {
    const { service, publisher } = setup();

    await expect(service.remove(as(MIRA), JONAS)).rejects.toMatchObject({
      status: 404,
      code: 'friendship-not-found',
    });
    expect(publisher.emits).toEqual([]);
  });

  it('IDOR: a third user cannot end or cancel a friendship they are not part of', async () => {
    const { service, repository, publisher } = setup();
    repository.seed(MIRA, JONAS, 'accepted');

    await expect(service.remove(as(ADA), JONAS)).rejects.toBeInstanceOf(FriendshipNotFoundError);
    await expect(service.remove(as(ADA), MIRA)).rejects.toBeInstanceOf(FriendshipNotFoundError);
    expect(repository.rowOf(MIRA, JONAS)).toMatchObject({ status: 'accepted' });
    expect(publisher.emits).toEqual([]);
    expect(publisher.leaves).toEqual([]);
  });

  it('removing oneself is 404 without a query', async () => {
    const { service, repository } = setup();

    await expect(service.remove(as(MIRA), MIRA)).rejects.toBeInstanceOf(FriendshipNotFoundError);
    expect(repository.calls).toEqual([]);
  });
});

describe('friends service: list (GET /api/friendships)', () => {
  it('F-54: splits the rows into friends, incoming and outgoing from the viewer’s point of view', async () => {
    const { service, repository } = setup();
    const theo = repository.addUser({ id: 4, firstName: 'Theo', lastName: 'Marsh' });
    repository.seed(MIRA, JONAS, 'accepted');
    repository.seed(ADA, MIRA, 'pending');
    repository.seed(MIRA, theo.id, 'pending');

    const page = FriendshipsResponse.parse(await service.list(as(MIRA)));

    expect(page.friends.map((entry) => entry.user.id)).toEqual([JONAS]);
    expect(page.incoming.map((entry) => entry.user.id)).toEqual([ADA]);
    expect(page.outgoing.map((entry) => entry.user.id)).toEqual([theo.id]);
  });

  it('B-52: the same row is incoming for one side and outgoing for the other', async () => {
    const { service, repository } = setup();
    repository.seed(ADA, MIRA, 'pending');

    const forMira = await service.list(as(MIRA));
    const forAda = await service.list(as(ADA));

    expect(forMira).toMatchObject({ incoming: [{ user: { id: ADA } }], outgoing: [], friends: [] });
    expect(forAda).toMatchObject({ outgoing: [{ user: { id: MIRA } }], incoming: [], friends: [] });
  });

  it('F-54: each list is ordered by name, case-insensitively, with the id as tie-breaker', async () => {
    const { service, repository } = setup();
    const viewer = repository.addUser({ id: 10, firstName: 'Viewer', lastName: 'Zed' });
    const names = [
      { id: 11, firstName: 'zoe', lastName: 'Adams' },
      { id: 12, firstName: 'Anna', lastName: 'Young' },
      { id: 13, firstName: 'anna', lastName: 'baker' },
      { id: 14, firstName: 'Anna', lastName: 'Baker' },
    ];
    for (const fields of names) repository.seed(viewer.id, repository.addUser(fields).id, 'accepted');

    const { friends } = await service.list(as(viewer.id));

    expect(friends.map((entry) => entry.user.id)).toEqual([13, 14, 12, 11]);
  });

  it('since is acceptedAt for friends and createdAt for requests, as ISO strings', async () => {
    const { service, repository } = setup();
    const createdAt = new Date('2026-03-01T10:00:00.000Z');
    const acceptedAt = new Date('2026-03-02T11:30:00.123Z');
    repository.seed(MIRA, JONAS, 'accepted', { createdAt, acceptedAt });
    repository.seed(ADA, MIRA, 'pending', { createdAt });

    const { friends, incoming } = await service.list(as(MIRA));

    expect(friends[0]?.since).toBe('2026-03-02T11:30:00.123Z');
    expect(incoming[0]?.since).toBe('2026-03-01T10:00:00.000Z');
  });

  it('B-19: entries carry only the public summary; the avatar is a URL, never the storage key', async () => {
    const { service, repository } = setup();
    const avatarKey = newAvatarKey(JONAS);
    repository.addUser({ id: JONAS, firstName: 'Jonas', lastName: 'Berg', avatarKey });
    repository.seed(MIRA, JONAS, 'accepted');

    const { friends } = FriendshipsResponse.parse(await service.list(as(MIRA)));

    expect(friends[0]?.user).toEqual({
      id: JONAS,
      firstName: 'Jonas',
      lastName: 'Berg',
      avatarUrl: createAvatarUrl()(JONAS, avatarKey),
    });
    expect(JSON.stringify(friends)).not.toContain(avatarKey);
  });

  it('is three empty lists for a user without friendships, and ignores other pairs', async () => {
    const { service, repository } = setup();
    repository.seed(JONAS, ADA, 'accepted');

    await expect(service.list(as(MIRA))).resolves.toEqual({ friends: [], incoming: [], outgoing: [] });
  });
});

describe('friends service: contract (B-53)', () => {
  it('answers states of the shared enum only, never UI labels', async () => {
    const { service } = setup();
    const states = [
      (await service.sendRequest(as(MIRA), JONAS)).state,
      (await service.accept(as(JONAS), MIRA)).state,
      (await service.remove(as(MIRA), JONAS)).state,
    ];

    expect(states).toEqual(['pending_outgoing', 'friends', 'none']);
    for (const state of states) expect(FriendshipState.safeParse(state).success).toBe(true);
  });

  it('maps every business error to its contract status and problem code (API.md §4)', () => {
    const cases: [AppError, number, string][] = [
      [new CannotBefriendSelfError(), 422, 'cannot-befriend-self'],
      [new UserNotFoundError(), 404, 'user-not-found'],
      [new FriendRequestNotFoundError(), 404, 'friend-request-not-found'],
      [new FriendshipNotFoundError(), 404, 'friendship-not-found'],
      [new FriendshipExistsError(), 409, 'friendship-exists'],
    ];

    for (const [error, status, code] of cases) {
      expect({ status: error.status, code: ProblemCode.parse(error.code) }).toEqual({ status, code });
    }
  });
});
