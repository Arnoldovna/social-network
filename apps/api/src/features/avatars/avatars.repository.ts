import { eq, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { users } from '../../db/schema/index.js';
import { publicUserColumns, type PublicUserRow } from '../../db/selections.js';

/** The result of the atomic key swap: the key that was replaced and the user's public columns after the update. */
export interface AvatarSwap {
  /** The avatar key this very update replaced (`null` when the user had none). */
  oldKey: string | null;
  user: PublicUserRow;
}

/** The service depends on this interface, so unit tests pass an in-memory fake (`__tests__/fakes.ts`). */
export interface AvatarsRepository {
  /**
   * Sets the user's avatar key and returns the key it replaced, in one statement (ADR-0010 §5). Concurrent swaps of
   * the same user serialise on the row lock, so each caller gets exactly the key its own update replaced. `undefined`
   * when the user does not exist.
   */
  swapAvatarKey(userId: number, newKey: string): Promise<AvatarSwap | undefined>;
  /** The user's current avatar key (`null` without an avatar), or `undefined` for an unknown user. PK lookup. */
  findAvatarKey(userId: number): Promise<{ avatarKey: string | null } | undefined>;
}

/*
 * Postgres 18 `RETURNING OLD.<column>` (DATA-MODEL "Set avatar"): the value the row had before this update. Plain
 * columns in the same RETURNING list are the new values. Drizzle has no builder for `old.`, so it is spelled with
 * `sql`, from the schema's own column name.
 */
const replacedAvatarKey = sql<string | null>`old.${sql.identifier(users.avatarKey.name)}`;

export function createAvatarsRepository(db: Database): AvatarsRepository {
  return {
    async swapAvatarKey(userId, newKey) {
      // `$onUpdate` sets `updated_at` as part of the same statement.
      const [row] = await db
        .update(users)
        .set({ avatarKey: newKey })
        .where(eq(users.id, userId))
        .returning({ ...publicUserColumns, oldKey: replacedAvatarKey });
      if (!row) return undefined;
      const { oldKey, ...user } = row;
      return { oldKey, user };
    },

    async findAvatarKey(userId) {
      const [row] = await db.select({ avatarKey: users.avatarKey }).from(users).where(eq(users.id, userId)).limit(1);
      return row;
    },
  };
}
