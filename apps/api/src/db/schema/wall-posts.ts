import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { users } from './users.js';

/**
 * Posts on a user's wall (DATA-MODEL.md). Text only: wall images (F-68) are out of scope for v1 (ADR-0011, B-71).
 * The body limit mirrors `POST_MAX` in `packages/shared/src/wall.ts`.
 */
export const wallPosts = pgTable(
  'wall_posts',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    wallOwnerId: integer('wall_owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    authorId: integer('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    // precision 3 = JS Date precision; the keyset cursor compares against this exact value (ADR-0014).
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    check('wall_posts_body_chk', sql`char_length(${t.body}) between 1 and 2000 and ${t.body} = btrim(${t.body})`),
    // Keyset ordering of one wall: created_at DESC, id DESC (ADR-0014). `.nullsFirst()` because drizzle renders a bare
    // `.desc()` as DESC NULLS LAST, while ORDER BY ... DESC means NULLS FIRST in Postgres; with the mismatch the
    // planner sorts the whole wall instead of reading the index in order (verified with EXPLAIN on Postgres 18).
    index('wall_posts_wall_created_idx').on(t.wallOwnerId, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
    index('wall_posts_author_idx').on(t.authorId),
  ],
);
