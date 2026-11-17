import { PublicUser, UserSummary } from '@app/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';

import type { AvatarUrl } from '../../shared/media/media-url.js';
import * as schema from '../schema/index.js';
import {
  publicUserColumns,
  type PublicUserRow,
  toPublicUser,
  toUserSummary,
  userSummaryColumns,
  type UserSummaryRow,
} from '../selections.js';

const { users, wallPosts } = schema;

// A query builder without a connection: renders SQL only, never talks to a database.
const db = drizzle.mock({ schema });

const avatarUrl: AvatarUrl = (userId, avatarKey) =>
  avatarKey === null ? null : `/api/users/${String(userId)}/avatar?v=${avatarKey.slice(-41, -5)}`;

const KEY = 'avatars/7/0f8fad5b-d9cb-469f-a165-70867728950e.webp';

const summaryRow: UserSummaryRow = { id: 7, firstName: 'Mira', lastName: 'Novak', avatarKey: KEY };
const publicRow: PublicUserRow = { ...summaryRow, bio: 'Front-end developer in Leipzig.' };

/** Every column a full `users` row has, i.e. what `select *` would return (B-19). */
const fullRow = {
  ...publicRow,
  email: 'mira.novak@example.com',
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
  createdAt: new Date('2026-11-01T10:00:00.000Z'),
  updatedAt: new Date('2026-11-02T10:00:00.000Z'),
} satisfies typeof users.$inferSelect;

describe('user column selections (B-19)', () => {
  it('userSummaryColumns selects exactly id, names and the avatar key', () => {
    const { sql } = db.select(userSummaryColumns).from(users).toSQL();

    expect(sql).toBe('select "id", "first_name", "last_name", "avatar_key" from "users"');
  });

  it('publicUserColumns adds only the bio', () => {
    const { sql } = db.select(publicUserColumns).from(users).toSQL();

    expect(sql).toBe('select "id", "first_name", "last_name", "avatar_key", "bio" from "users"');
  });

  it('never selects private columns, also when nested in a join', () => {
    const { sql } = db
      .select({ id: wallPosts.id, author: userSummaryColumns })
      .from(wallPosts)
      .innerJoin(users, eq(users.id, wallPosts.authorId))
      .toSQL();

    expect(sql).toContain('"users"."first_name"');
    for (const column of ['email', 'password_hash', 'created_at', 'updated_at']) {
      expect(sql).not.toContain(`"users"."${column}"`);
    }
  });
});

describe('toUserSummary', () => {
  it('maps a row to a UserSummary that passes the strict shared schema', () => {
    const summary = toUserSummary(summaryRow, avatarUrl);

    expect(summary).toEqual({
      id: 7,
      firstName: 'Mira',
      lastName: 'Novak',
      avatarUrl: '/api/users/7/avatar?v=0f8fad5b-d9cb-469f-a165-70867728950e',
    });
    expect(UserSummary.parse(summary)).toEqual(summary);
  });

  it('passes the user id and the stored key to the avatar resolver', () => {
    const resolver = vi.fn<AvatarUrl>(() => '/avatar');

    toUserSummary(summaryRow, resolver);

    expect(resolver).toHaveBeenCalledExactlyOnceWith(7, KEY);
  });

  it('yields avatarUrl null when the user has no avatar', () => {
    expect(toUserSummary({ ...summaryRow, avatarKey: null }, avatarUrl).avatarUrl).toBeNull();
  });

  it('never leaks the key or private fields of a wider row', () => {
    const summary = toUserSummary(fullRow, avatarUrl);

    expect(Object.keys(summary).sort()).toEqual(['avatarUrl', 'firstName', 'id', 'lastName']);
    expect(JSON.stringify(summary)).not.toMatch(/argon2|example\.com|avatars\//);
    expect(() => UserSummary.parse(summary)).not.toThrow();
  });
});

describe('toPublicUser', () => {
  it('maps a row to a PublicUser that passes the strict shared schema', () => {
    const user = toPublicUser(publicRow, avatarUrl);

    expect(user).toEqual({
      id: 7,
      firstName: 'Mira',
      lastName: 'Novak',
      avatarUrl: '/api/users/7/avatar?v=0f8fad5b-d9cb-469f-a165-70867728950e',
      bio: 'Front-end developer in Leipzig.',
    });
    expect(PublicUser.parse(user)).toEqual(user);
  });

  it('keeps a missing bio as null (no `|| null` coercion of other values, B-76)', () => {
    const user = toPublicUser({ ...publicRow, bio: null, avatarKey: null }, avatarUrl);

    expect(user.bio).toBeNull();
    expect(user.avatarUrl).toBeNull();
    expect(() => PublicUser.parse(user)).not.toThrow();
  });

  it('never leaks the key or private fields of a wider row', () => {
    const user = toPublicUser(fullRow, avatarUrl);

    expect(Object.keys(user).sort()).toEqual(['avatarUrl', 'bio', 'firstName', 'id', 'lastName']);
    expect(JSON.stringify(user)).not.toMatch(/argon2|example\.com|avatars\//);
    expect(() => PublicUser.parse(user)).not.toThrow();
  });
});
