import { and, eq, ne, or, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { users } from '../../db/schema/index.js';
import {
  publicUserColumns,
  type PublicUserRow,
  userNameOrder,
  userSummaryColumns,
  type UserSummaryRow,
} from '../../db/selections.js';
import { LIKE_ESCAPE } from './search-pattern.js';

export interface SearchUsersParams {
  /** A `LIKE` pattern from `prefixPattern()`: escaped and ending in `%`. Case folding happens in SQL. */
  pattern: string;
  /** The signed-in user, never part of their own results (F-61). */
  excludeUserId: number;
  limit: number;
}

/**
 * SQL of the users feature (DATA-MODEL.md, "Key queries"). Every method takes already-validated, typed input (B-76)
 * and selects through the shared column sets (`db/selections.ts`), so email, password hash and timestamps never leave
 * this file (B-19, F-43). The service depends on this interface; unit tests use the fake in `__tests__/fakes.ts`.
 */
export interface UsersRepository {
  /** The public columns of one user, or `undefined` if no user has this id. */
  findPublicById(id: number): Promise<PublicUserRow | undefined>;
  /** Sets the bio (`null` clears it) and returns the updated public columns; `undefined` if the user does not exist. */
  updateBio(id: number, bio: string | null): Promise<PublicUserRow | undefined>;
  /** Prefix matches on first, last or full name, ordered by name, at most `limit` rows. */
  search(params: SearchUsersParams): Promise<UserSummaryRow[]>;
}

/**
 * `lower(<expression>) like lower(<pattern>) escape '\'`. Each left-hand side is exactly the expression of one of the
 * three `text_pattern_ops` prefix indexes (`users_{first,last,full}_name_prefix_idx`), so Postgres can answer the `or`
 * with a bitmap of index range scans. The pattern is a bound parameter; `lower()` on it is folded to a constant at
 * planning time.
 */
function likePrefix(expression: SQL, pattern: string): SQL {
  return sql`lower(${expression}) like lower(${pattern}) escape ${LIKE_ESCAPE}`;
}

export function createUsersRepository(db: Database): UsersRepository {
  return {
    async findPublicById(id) {
      const [row] = await db.select(publicUserColumns).from(users).where(eq(users.id, id)).limit(1);
      return row;
    },

    async updateBio(id, bio) {
      // `updated_at` is bumped by the schema's `$onUpdate`.
      const [row] = await db.update(users).set({ bio }).where(eq(users.id, id)).returning(publicUserColumns);
      return row;
    },

    async search({ pattern, excludeUserId, limit }) {
      return db
        .select(userSummaryColumns)
        .from(users)
        .where(
          and(
            ne(users.id, excludeUserId),
            or(
              likePrefix(sql`${users.firstName}`, pattern),
              likePrefix(sql`${users.lastName}`, pattern),
              // Parenthesised as in the index definition: `lower(first_name || ' ' || last_name)`.
              likePrefix(sql`${users.firstName} || ' ' || ${users.lastName}`, pattern),
            ),
          ),
        )
        .orderBy(...userNameOrder())
        .limit(limit);
    },
  };
}
