import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { isTrimmed } from './trimmed.js';
import { users } from './users.js';

/**
 * Messages of the one shared chat room (DATA-MODEL.md; no private messages in v1, ADR-0011). The body limit mirrors
 * `CHAT_MAX` in `packages/shared/src/chat.ts`.
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    authorId: integer('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    // precision 3 = JS Date precision; the keyset cursor compares against this exact value (ADR-0014).
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    check('chat_messages_body_chk', sql`char_length(${t.body}) between 1 and 1000 and ${isTrimmed(t.body)}`),
    // Keyset ordering of the chat: created_at DESC, id DESC (ADR-0014). `.nullsFirst()` matches Postgres' default for
    // ORDER BY ... DESC; drizzle's bare `.desc()` renders NULLS LAST, which the planner cannot use for that ordering.
    index('chat_messages_created_idx').on(t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
    index('chat_messages_author_idx').on(t.authorId),
  ],
);
