import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import type { Database } from '../src/db/client.js';
import { chatMessages, friendships, users, wallPosts } from '../src/db/schema/index.js';
import { newAvatarKey } from '../src/shared/media/media-url.js';

/**
 * Typed inserters for the four tables (BUILD-ORDER 1b "Test helpers", ADR-0016; frozen after Phase 1b). Each call is
 * one statement (two for `insertUser({ avatar: true })`) on the given database, normally `testApp.db` (the test file's
 * own clone of the migrated template).
 *
 * There is **no truncation helper**: every test file has its own database, and tests still create their own users and
 * assert only on their own rows, so a file can hold many tests in any order.
 */

export type UserRow = typeof users.$inferSelect;
export type FriendshipRow = typeof friendships.$inferSelect;
export type WallPostRow = typeof wallPosts.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;

/** The password of every user `insertUser` creates (only the auth unit's own tests ever log in with it). */
export const TEST_USER_PASSWORD = 'integration test password';

/**
 * argon2id of `TEST_USER_PASSWORD` with the parameters pinned in `shared/auth/password.ts` (m=64 MiB, t=3, p=4), so
 * `argon2Hasher.verify` accepts it and `needsRehash` is false (test/harness.int.test.ts proves both). Precomputed:
 * signing a user in through the test route never pays for hashing, and B-16 tests still see the real `$argon2id$`
 * format.
 */
export const TEST_USER_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$nKKNz3DAViwgrIzz1sgOLA$DP1ZzjMglUFZuNbHNtre42CEKD6Bqe1BdCDgbed/8Ps';

/** A unique, valid email (`<uuid>@example.com`, lower case like every stored email). */
export function uniqueEmail(): string {
  return `${randomUUID()}@example.com`;
}

export interface InsertUserFields {
  firstName?: string;
  /** Defaults to `User-<8 hex>`, unique per call, so name searches only find the test's own users. */
  lastName?: string;
  /** Defaults to `uniqueEmail()`. Must already be trimmed and lower case (`users_email_lowercase_chk`). */
  email?: string;
  bio?: string | null;
  /**
   * Gives the user a server-made avatar key, `newAvatarKey(id)` (`avatars/<id>/<uuid>.webp`). The key contains the
   * generated id, which `users_avatar_key_chk` ties to the row, so it is set by a second statement after the insert.
   * Put the object into the fake storage under `row.avatarKey` if the test serves it.
   */
  avatar?: boolean;
  /** Defaults to `TEST_USER_PASSWORD_HASH`. */
  passwordHash?: string;
  /** Also used as `updatedAt`; defaults to the database's `now()`. */
  createdAt?: Date;
}

/**
 * Inserts one user and returns the full row (including `email` and `passwordHash`, for assertions on leaks). One
 * statement, plus one update for `avatar: true`.
 */
export async function insertUser(db: Database, fields: InsertUserFields = {}): Promise<UserRow> {
  const { createdAt, avatar = false, ...rest } = fields;
  const [row] = await db
    .insert(users)
    .values({
      firstName: 'Test',
      lastName: `User-${randomUUID().slice(0, 8)}`,
      email: uniqueEmail(),
      passwordHash: TEST_USER_PASSWORD_HASH,
      ...rest,
      ...(createdAt ? { createdAt, updatedAt: createdAt } : {}),
    })
    .returning();
  if (!row) throw new Error('insertUser: the insert returned no row');
  if (!avatar) return row;

  // `updatedAt` is set explicitly, so `$onUpdate` does not bump it: it keeps the inserted (or explicit) value.
  const [withAvatar] = await db
    .update(users)
    .set({ avatarKey: newAvatarKey(row.id), updatedAt: row.updatedAt })
    .where(eq(users.id, row.id))
    .returning();
  if (!withAvatar) throw new Error('insertUser: the avatar update returned no row');
  return withAvatar;
}

export interface InsertFriendshipOptions {
  /** Defaults to the database's `now()`. */
  createdAt?: Date;
  /** Only for `accepted`; defaults to `createdAt`, else `now()`. */
  acceptedAt?: Date;
}

/**
 * Inserts the one row of the pair: `requesterId` asked `addresseeId` (`pending_outgoing` for the requester,
 * `pending_incoming` for the addressee), or they are friends (`accepted`). A second row for the same pair in either
 * direction violates `friendships_pair_idx`, a self pair `friendships_not_self_chk`: both reject.
 */
export async function insertFriendship(
  db: Database,
  requesterId: number,
  addresseeId: number,
  status: 'pending' | 'accepted',
  { createdAt, acceptedAt }: InsertFriendshipOptions = {},
): Promise<FriendshipRow> {
  if (acceptedAt && status !== 'accepted') {
    throw new RangeError('insertFriendship: only an accepted friendship has acceptedAt');
  }
  const [row] = await db
    .insert(friendships)
    .values({
      requesterId,
      addresseeId,
      status,
      ...(createdAt ? { createdAt } : {}),
      acceptedAt: status === 'accepted' ? (acceptedAt ?? createdAt ?? new Date()) : null,
    })
    .returning();
  if (!row) throw new Error('insertFriendship: the insert returned no row');
  return row;
}

export interface InsertManyOptions {
  /**
   * One timestamp for every row (ties are broken by id, ADR-0014) or one per row by index. Defaults to the
   * database's `now()`, the same value for all rows of the statement.
   */
  createdAt?: Date | ((index: number) => Date);
  /** The body of row `index` (0-based); must be trimmed and within the table's length check. */
  body?: (index: number) => string;
}

function checkedCount(count: number, helper: string): number {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError(`${helper}: count must be a positive integer`);
  }
  return count;
}

function createdAtOf(option: InsertManyOptions['createdAt'], index: number): { createdAt?: Date } {
  if (option === undefined) return {};
  return { createdAt: typeof option === 'function' ? option(index) : option };
}

/**
 * Inserts `count` posts by `authorId` on `wallOwnerId`'s wall in one statement (pagination tests insert 25 at once,
 * BUILD-ORDER Phase 2). Returns the rows in insertion order (ascending id). Default bodies are `Post <n>` (1-based).
 */
export async function insertWallPosts(
  db: Database,
  wallOwnerId: number,
  authorId: number,
  count: number,
  { createdAt, body = (index) => `Post ${String(index + 1)}` }: InsertManyOptions = {},
): Promise<WallPostRow[]> {
  const values = Array.from({ length: checkedCount(count, 'insertWallPosts') }, (_, index) => ({
    wallOwnerId,
    authorId,
    body: body(index),
    ...createdAtOf(createdAt, index),
  }));
  const rows = await db.insert(wallPosts).values(values).returning();
  return rows.sort((a, b) => a.id - b.id);
}

/**
 * Inserts `count` chat messages by `authorId` in one statement. Returns the rows in insertion order (ascending id).
 * Default bodies are `Message <n>` (1-based). The chat is global, but every file has its own database, so a file
 * starts with an empty chat; tests still filter on their own author.
 */
export async function insertChatMessages(
  db: Database,
  authorId: number,
  count: number,
  { createdAt, body = (index) => `Message ${String(index + 1)}` }: InsertManyOptions = {},
): Promise<ChatMessageRow[]> {
  const values = Array.from({ length: checkedCount(count, 'insertChatMessages') }, (_, index) => ({
    authorId,
    body: body(index),
    ...createdAtOf(createdAt, index),
  }));
  const rows = await db.insert(chatMessages).values(values).returning();
  return rows.sort((a, b) => a.id - b.id);
}
