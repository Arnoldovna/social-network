import { sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { users } from '../../db/schema/index.js';
import { userNameOrder, userSummaryColumns, type UserSummaryRow } from '../../db/selections.js';

/** The one Postgres read of presence (DATA-MODEL.md, query table "Presence list"). */
export interface PresenceRepository {
  /**
   * The public columns of the given users (B-19), ordered by name like every other user list: case-insensitive first
   * name, then last name, then id as the tie-breaker. Ids without a user row are simply absent.
   */
  findSummariesByIds(ids: readonly number[]): Promise<UserSummaryRow[]>;
}

export function createPresenceRepository(db: Database): PresenceRepository {
  return {
    async findSummariesByIds(ids) {
      if (ids.length === 0) return [];
      // One array parameter (`= any($1::integer[])`) instead of `in ($1, …, $n)`: one statement shape for any number
      // of online users, far below the 65,535 bind-parameter limit.
      return db
        .select(userSummaryColumns)
        .from(users)
        .where(sql`${users.id} = any(${sql.param([...ids])}::integer[])`)
        .orderBy(...userNameOrder());
    },
  };
}
