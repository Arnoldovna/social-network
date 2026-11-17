import type { PublicUser, UserSummary } from '@app/shared';
import { asc, sql, type SQL } from 'drizzle-orm';

import type { AvatarUrl } from '../shared/media/media-url.js';
import { users } from './schema/index.js';

/**
 * Explicit column selections and DTO mappers for users (B-19, ADR-0003). Every repository that returns a user to
 * another user selects through these objects, never `select *`, so `email`, `password_hash` and timestamps cannot
 * reach a DTO by accident. Use them as a whole or nested, e.g. `db.select({ id: wallPosts.id, author:
 * userSummaryColumns })`.
 *
 * The avatar is selected as its storage key; the public URL is built at read time (ADR-0010, B-05).
 */
export const userSummaryColumns = {
  id: users.id,
  firstName: users.firstName,
  lastName: users.lastName,
  avatarKey: users.avatarKey,
} as const;

/** `userSummaryColumns` plus the bio: the profile page and the signed-in user (`Me`). */
export const publicUserColumns = {
  ...userSummaryColumns,
  bio: users.bio,
} as const;

/**
 * The order of every list of users (search, friends, presence; DATA-MODEL.md): case-insensitive first name, then last
 * name, then the id as a stable tie-breaker. Use as `.orderBy(...userNameOrder())`.
 */
export function userNameOrder(): SQL[] {
  return [asc(sql`lower(${users.firstName})`), asc(sql`lower(${users.lastName})`), asc(users.id)];
}

type UserRow = typeof users.$inferSelect;

/** What `db.select(userSummaryColumns)` returns per row. */
export type UserSummaryRow = Pick<UserRow, keyof typeof userSummaryColumns>;
/** What `db.select(publicUserColumns)` returns per row. */
export type PublicUserRow = Pick<UserRow, keyof typeof publicUserColumns>;

/**
 * Row -> `UserSummary`. Picks each field explicitly (no spread of `row`), so a wider row, e.g. one that also carries
 * `email`, still yields exactly the four DTO keys that the strict shared schema accepts. The avatar URL builder
 * (`createAvatarUrl()` from `shared/media/media-url.ts`) is a parameter, so `db/` does not decide how media is
 * addressed.
 */
export function toUserSummary(row: UserSummaryRow, avatarUrl: AvatarUrl): UserSummary {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    avatarUrl: avatarUrl(row.id, row.avatarKey),
  };
}

/** Row -> `PublicUser` (also the shape of `Me`). Same explicit picking as `toUserSummary`. */
export function toPublicUser(row: PublicUserRow, avatarUrl: AvatarUrl): PublicUser {
  return {
    ...toUserSummary(row, avatarUrl),
    bio: row.bio,
  };
}
