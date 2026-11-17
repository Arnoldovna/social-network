import { describe, expect, it } from 'vitest';

import { createAvatarUrl, newAvatarKey, parseAvatarKey } from '../media-url.js';

/** The pattern part of the DATA-MODEL check constraint on `users.avatar_key` (it also ties the id to the row). */
const DB_KEY_CHECK = /^avatars\/[1-9][0-9]*\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
const UUID = '0b6f7c1e-5a2d-4c3b-9e8f-1a2b3c4d5e6f';

describe('newAvatarKey (FEATURES Appendix C, B-30)', () => {
  it('builds a server-generated WebP key the database accepts', () => {
    const key = newAvatarKey(7);

    expect(key).toMatch(DB_KEY_CHECK);
    expect(parseAvatarKey(key)).toEqual({ userId: 7, version: expect.any(String) as string });
  });

  it('never repeats a key', () => {
    expect(newAvatarKey(7)).not.toBe(newAvatarKey(7));
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses user id %s', (userId) => {
    expect(() => newAvatarKey(userId)).toThrow(RangeError);
  });
});

describe('parseAvatarKey', () => {
  it('reads the user id and the uuid version', () => {
    expect(parseAvatarKey(`avatars/12/${UUID}.webp`)).toEqual({ userId: 12, version: UUID });
  });

  it.each([
    ['another extension', `avatars/12/${UUID}.png`],
    ['an uppercase uuid', `avatars/12/${UUID.toUpperCase()}.webp`],
    ['a path traversal', `avatars/12/../13/${UUID}.webp`],
    ['another prefix', `images/12/${UUID}.webp`],
    ['a leading zero in the user id', `avatars/012/${UUID}.webp`],
    ['a trailing newline', `avatars/12/${UUID}.webp\n`],
    ['an empty string', ''],
  ])('returns null for %s', (_case, key) => {
    expect(parseAvatarKey(key)).toBeNull();
  });
});

describe('createAvatarUrl (ADR-0010 §8, B-05)', () => {
  const avatarUrl = createAvatarUrl();

  it('returns the stable per-user route with the key uuid as version', () => {
    expect(avatarUrl(12, `avatars/12/${UUID}.webp`)).toBe(`/api/users/12/avatar?v=${UUID}`);
  });

  it('returns null for a user without an avatar', () => {
    expect(avatarUrl(12, null)).toBeNull();
  });

  it('changes the URL with every new key, so caches pick up a new upload (F-37)', () => {
    const first = avatarUrl(3, newAvatarKey(3));
    const second = avatarUrl(3, newAvatarKey(3));

    expect(first).toMatch(/^\/api\/users\/3\/avatar\?v=[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });

  it('throws for a key that belongs to another user', () => {
    expect(() => avatarUrl(12, `avatars/13/${UUID}.webp`)).toThrow(/user 12/);
  });

  it('throws for a key outside the server pattern instead of publishing it', () => {
    expect(() => avatarUrl(12, 'https://evil.example/x.webp')).toThrow();
  });
});
