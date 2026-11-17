import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

import type { Cursor } from '../shared/pagination/cursor.js';

/** The two columns of a newest-first keyset: `ORDER BY <createdAt> DESC, <id> DESC` (ADR-0014). */
export interface KeysetColumns {
  createdAt: AnyColumn;
  id: AnyColumn;
}

/**
 * The `WHERE` condition of the page after `cursor` (ADR-0014; DATA-MODEL "Wall page", "Chat page"), written once for
 * the wall and the chat. It is one row comparison `(created_at, id) < ($t, $id)`: the `(…, created_at DESC, id DESC)`
 * indexes serve it without a sort, and it stays stable when several rows share a millisecond. Both values are bound
 * parameters with explicit types, so the comparison is exactly `(timestamptz, integer) < (timestamptz, integer)`, and
 * `$t` is the cursor's UTC ISO string, exact to the millisecond of the `timestamptz(3)` columns whatever the
 * session's time zone. `undefined` for the first page, which `and()` and `where()` skip.
 */
export function keysetAfter({ createdAt, id }: KeysetColumns, cursor: Cursor | undefined): SQL | undefined {
  if (!cursor) return undefined;
  return sql`(${createdAt}, ${id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::integer)`;
}
