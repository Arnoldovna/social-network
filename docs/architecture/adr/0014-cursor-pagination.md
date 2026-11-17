# ADR-0014: Keyset (cursor) pagination for walls and chat

- Status: accepted (revised after the architecture critique: millisecond timestamp columns)
- Date: 2026-11-15
- Related: B-72, B-73, F-70, F-76, F-82

## Context

Legacy loaded every post of a wall (B-73), only the last 10 chat messages with no way back (B-73), and sorted
ascending in SQL then reversed in JavaScript (B-72).

## Decision

- Template helpers from `shared/pagination/cursor.ts`: order `created_at DESC, id DESC`, row comparison
  `(created_at, id) < ($t, $id)`, fetch `limit + 1`, cursor = base64url JSON `{ t, id }` validated on decode
  (400 `invalid-cursor`).
- **The cursor columns are `timestamptz(3)`** (`timestamp('created_at', { withTimezone: true, precision: 3 })`).
  The cursor encodes `Date.toISOString()` (milliseconds); a default `timestamptz` stores microseconds, so `$t` would
  be truncated and every row in the same millisecond as a page's last row but older than it would be skipped
  (e.g. 25 rows inserted by one statement share one `now()`, and page 2 would be empty). With precision 3 the
  stored value equals the JS `Date`, and the `id` tie-breaker orders rows with equal timestamps.
- Regression test in the wall and chat integration suites: insert 25 rows in one statement, page through them
  with `limit=10`, every id appears exactly once and in order.
- Page size 20 by default, max 50 (`PageQuery`).
- Indexes: `wall_posts (wall_owner_id, created_at DESC, id DESC)`, `chat_messages (created_at DESC, id DESC)`.
  In drizzle they are written `.desc().nullsFirst()`: a bare `.desc()` renders `DESC NULLS LAST`, which Postgres
  cannot use for `ORDER BY created_at DESC, id DESC` (implicitly `NULLS FIRST`), so every page would sort the whole
  wall (verified with EXPLAIN on Postgres 18; amended in Phase 1b).
- Wall: newest first, "load older posts" button (no infinite scroll, which is hostile to keyboard and footer access).
- Chat: the API returns newest first; the client reverses each page for display (oldest at top, F-76) and loads
  older pages with a "load older messages" button at the top while keeping the scroll anchor.
- Real-time inserts go to the top of the first wall page / bottom of the chat; deletions remove by id from any page.

## Alternatives

- **Offset pagination**: duplicates/skips rows while new posts arrive; forbidden by the house rules for growing
  tables.
- **Id-only cursor**: would also work (identity ids are monotonic within one database, and the seed inserts in
  chronological order), but deviates from the template and would make the order depend on insertion order instead
  of the timestamp the UI shows. Precision 3 fixes the actual defect with a one-word schema change.

## Consequences

- No total counts (not needed by the UI).
- Real-time inserts plus a later "load older" fetch can never duplicate rows, because the cursor is the last loaded
  row, not an offset.
