import { MeResponse, SearchResponse, UserProfileResponse, type RelationshipState } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { createFakeFriendshipReader } from '../../../../test/fakes.js';
import { UnauthorizedError, UserNotFoundError } from '../../../shared/errors/app-error.js';
import { createAvatarUrl, newAvatarKey } from '../../../shared/media/media-url.js';
import { createUsersService } from '../users.service.js';
import { createFakeUsersRepository } from './fakes.js';

function setup() {
  const repository = createFakeUsersRepository();
  const friendships = createFakeFriendshipReader();
  const service = createUsersService({ repository, friendships, avatarUrl: createAvatarUrl() });
  return { repository, friendships, service };
}

/** `/api/users/<id>/avatar?v=<uuid>` for a key from `newAvatarKey(id)` (ADR-0010). */
function avatarUrlOf(userId: number, key: string): string {
  const version = /([0-9a-f-]{36})\.webp$/.exec(key)?.[1];
  return `/api/users/${String(userId)}/avatar?v=${String(version)}`;
}

describe('users service: own profile', () => {
  it('F-21: getMe returns exactly the public fields of the signed-in user', async () => {
    const { repository, service } = setup();
    const me = repository.add({ firstName: 'Ada', lastName: 'Lovelace', bio: 'Engines.' });

    const response = await service.getMe({ userId: me.id });

    expect(MeResponse.parse(response)).toEqual({
      user: { id: me.id, firstName: 'Ada', lastName: 'Lovelace', bio: 'Engines.', avatarUrl: null },
    });
  });

  it('builds the avatar URL from the stored key (never the key itself)', async () => {
    const { repository, service } = setup();
    // The fake hands out ids from 1, and a stored key always carries its own user's id (users_avatar_key_chk).
    const key = newAvatarKey(1);
    const me = repository.add({ firstName: 'Ada', avatarKey: key });

    const { user } = await service.getMe({ userId: me.id });

    expect(user.avatarUrl).toBe(avatarUrlOf(me.id, key));
    expect(JSON.stringify(user)).not.toContain('avatars/');
  });

  it('answers 401 when the session names a user that does not exist', async () => {
    const { service } = setup();
    await expect(service.getMe({ userId: 42 })).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(service.updateMe({ userId: 42 }, { bio: 'x' })).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('F-29: stores the validated bio and returns the updated profile', async () => {
    const { repository, service } = setup();
    const me = repository.add({ firstName: 'Ada' });

    const response = await service.updateMe({ userId: me.id }, { bio: 'Analytical engines.' });

    expect(response.user.bio).toBe('Analytical engines.');
    expect(repository.get(me.id)?.bio).toBe('Analytical engines.');
  });

  it('F-28: saving the unchanged bio keeps it', async () => {
    const { repository, service } = setup();
    const me = repository.add({ firstName: 'Ada', bio: 'Unchanged.' });

    const response = await service.updateMe({ userId: me.id }, { bio: 'Unchanged.' });

    expect(response.user.bio).toBe('Unchanged.');
    expect(repository.get(me.id)?.bio).toBe('Unchanged.');
  });

  it('F-28: only an explicit null (a cleared bio after validation) removes it', async () => {
    const { repository, service } = setup();
    const me = repository.add({ firstName: 'Ada', bio: 'To be removed.' });

    const response = await service.updateMe({ userId: me.id }, { bio: null });

    expect(response.user.bio).toBeNull();
    expect(repository.get(me.id)?.bio).toBeNull();
  });

  it('changes only the signed-in user, never another row', async () => {
    const { repository, service } = setup();
    const me = repository.add({ firstName: 'Ada' });
    const other = repository.add({ firstName: 'Grace', bio: 'Compilers.' });

    await service.updateMe({ userId: me.id }, { bio: 'Mine.' });

    expect(repository.get(other.id)?.bio).toBe('Compilers.');
  });
});

describe('users service: other profiles', () => {
  it('F-40, B-78: shows another user with their bio', async () => {
    const { repository, service } = setup();
    const me = repository.add({ firstName: 'Ada' });
    const them = repository.add({ firstName: 'Grace', lastName: 'Hopper', bio: 'Compilers.' });

    const response = await service.getProfile({ userId: me.id }, them.id);

    expect(UserProfileResponse.parse(response).user).toEqual({
      id: them.id,
      firstName: 'Grace',
      lastName: 'Hopper',
      bio: 'Compilers.',
      avatarUrl: null,
    });
  });

  it('F-42, B-55: a well-formed id of nobody is user-not-found', async () => {
    const { repository, service } = setup();
    const me = repository.add({ firstName: 'Ada' });

    const failure = service.getProfile({ userId: me.id }, 999);

    await expect(failure).rejects.toBeInstanceOf(UserNotFoundError);
    await expect(failure).rejects.toMatchObject({ status: 404, code: 'user-not-found' });
  });

  it('F-41: the own id is "self" and allows the own wall', async () => {
    const { repository, service } = setup();
    const me = repository.add({ firstName: 'Ada' });

    const { relationship } = await service.getProfile({ userId: me.id }, me.id);

    expect(relationship).toEqual({ state: 'self', canViewWall: true, canPostOnWall: true });
  });

  it.each<{
    name: string;
    link: (friendships: ReturnType<typeof createFakeFriendshipReader>, me: number, them: number) => void;
    state: RelationshipState;
    allowed: boolean;
  }>([
    { name: 'no friendship', link: () => undefined, state: 'none', allowed: false },
    {
      name: 'a request I sent',
      link: (f, me, them) => {
        f.set(me, them, 'pending');
      },
      state: 'pending_outgoing',
      allowed: false,
    },
    {
      name: 'a request I received',
      link: (f, me, them) => {
        f.set(them, me, 'pending');
      },
      state: 'pending_incoming',
      allowed: false,
    },
    {
      name: 'a friendship I asked for',
      link: (f, me, them) => {
        f.set(me, them, 'accepted');
      },
      state: 'friends',
      allowed: true,
    },
    {
      name: 'a friendship they asked for',
      link: (f, me, them) => {
        f.set(them, me, 'accepted');
      },
      state: 'friends',
      allowed: true,
    },
  ])('F-45, F-65, F-66: $name → $state, wall allowed: $allowed', async ({ link, state, allowed }) => {
    const { repository, friendships, service } = setup();
    const me = repository.add({ firstName: 'Ada' });
    const them = repository.add({ firstName: 'Grace' });
    link(friendships, me.id, them.id);

    const { relationship } = await service.getProfile({ userId: me.id }, them.id);

    expect(relationship).toEqual({ state, canViewWall: allowed, canPostOnWall: allowed });
  });

  it('F-45: the state is per viewer: the same pending row reads differently from each side', async () => {
    const { repository, friendships, service } = setup();
    const ada = repository.add({ firstName: 'Ada' });
    const grace = repository.add({ firstName: 'Grace' });
    friendships.set(ada.id, grace.id, 'pending');

    const fromAda = await service.getProfile({ userId: ada.id }, grace.id);
    const fromGrace = await service.getProfile({ userId: grace.id }, ada.id);

    expect(fromAda.relationship.state).toBe('pending_outgoing');
    expect(fromGrace.relationship.state).toBe('pending_incoming');
  });
});

describe('users service: search', () => {
  function seedPeople() {
    const context = setup();
    const { repository } = context;
    const me = repository.add({ firstName: 'Ada', lastName: 'Searcher' });
    const people = {
      adaLovelace: repository.add({ firstName: 'Ada', lastName: 'Lovelace' }),
      adamSmith: repository.add({ firstName: 'Adam', lastName: 'Smith' }),
      graceHopper: repository.add({ firstName: 'Grace', lastName: 'Hopper' }),
      nadia: repository.add({ firstName: 'Nadia', lastName: 'Adams' }),
    };
    return { ...context, me, people };
  }

  it('F-60: matches the beginning of first, last or full name, case-insensitively', async () => {
    const { service, me, people } = seedPeople();
    const ids = async (q: string): Promise<number[]> =>
      (await service.search({ userId: me.id }, { q, limit: 10 })).items.map((item) => item.id);

    expect(await ids('ADA')).toEqual([people.adaLovelace.id, people.adamSmith.id, people.nadia.id]);
    expect(await ids('hop')).toEqual([people.graceHopper.id]);
    expect(await ids('ada lov')).toEqual([people.adaLovelace.id]);
    expect(await ids('lovelace ada')).toEqual([]);
    // Not a substring search: "dam" is inside "Adam" and "Adams", but at the start of no name.
    expect(await ids('dam')).toEqual([]);
  });

  it('F-61, B-49: returns all matches up to the limit, ordered by name, never only the first', async () => {
    const { service, me, people } = seedPeople();

    const all = await service.search({ userId: me.id }, { q: 'a', limit: 10 });
    const limited = await service.search({ userId: me.id }, { q: 'a', limit: 2 });

    expect(SearchResponse.parse(all).items.map((item) => item.id)).toEqual([
      people.adaLovelace.id,
      people.adamSmith.id,
      people.nadia.id,
    ]);
    expect(limited.items.map((item) => item.id)).toEqual([people.adaLovelace.id, people.adamSmith.id]);
  });

  it('F-61: excludes the searcher even when their own name matches', async () => {
    const { service, repository, me } = seedPeople();

    const { items } = await service.search({ userId: me.id }, { q: 'Ada', limit: 10 });

    expect(items.map((item) => item.id)).not.toContain(me.id);
    expect(repository.searches.at(-1)?.excludeUserId).toBe(me.id);
  });

  it('B-49: no match is an empty list, not an error', async () => {
    const { service, me } = seedPeople();
    await expect(service.search({ userId: me.id }, { q: 'Zebulon', limit: 10 })).resolves.toEqual({ items: [] });
  });

  it('B-74: % and _ in the term are literal characters, not wildcards', async () => {
    const { service, repository } = setup();
    const me = repository.add({ firstName: 'Me' });
    const percent = repository.add({ firstName: '50%', lastName: 'Off' });
    repository.add({ firstName: '50x', lastName: 'Off' });
    const underscore = repository.add({ firstName: 'a_b', lastName: 'Underscore' });
    repository.add({ firstName: 'axb', lastName: 'Underscore' });

    const percentHits = await service.search({ userId: me.id }, { q: '50%', limit: 10 });
    const underscoreHits = await service.search({ userId: me.id }, { q: 'a_b', limit: 10 });
    const everyone = await service.search({ userId: me.id }, { q: '%', limit: 10 });

    expect(percentHits.items.map((item) => item.id)).toEqual([percent.id]);
    expect(underscoreHits.items.map((item) => item.id)).toEqual([underscore.id]);
    // A bare "%" is a literal percent sign at the start of a name, not "match everyone"; nobody's name starts with it.
    expect(everyone.items).toEqual([]);
    expect(repository.searches.map((search) => search.pattern)).toEqual(['50\\%%', 'a\\_b%', '\\%%']);
  });

  it('B-19: results are UserSummary only (no bio, no key)', async () => {
    const { service, repository } = setup();
    const me = repository.add({ firstName: 'Me' });
    const key = newAvatarKey(2);
    const grace = repository.add({ firstName: 'Grace', bio: 'Private enough.', avatarKey: key });

    const { items } = await service.search({ userId: me.id }, { q: 'Grace', limit: 10 });

    expect(SearchResponse.parse({ items }).items).toHaveLength(1);
    expect(items).toEqual([
      { id: grace.id, firstName: 'Grace', lastName: 'Tester', avatarUrl: avatarUrlOf(grace.id, key) },
    ]);
  });
});
