import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { users } from './users.js';

/** Stored state of a friendship row. The per-viewer `FriendshipState` is derived from it, never stored (B-53). */
export const friendshipStatus = pgEnum('friendship_status', ['pending', 'accepted']);

/**
 * One row per unordered pair of users (DATA-MODEL.md, ADR-0007): `requester_id` is whoever asked first. Inserts use
 * `ON CONFLICT DO NOTHING` against `friendships_pair_idx`, so concurrent requests in both directions cannot create two
 * rows (B-25).
 */
export const friendships = pgTable(
  'friendships',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    requesterId: integer('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addresseeId: integer('addressee_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: friendshipStatus('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, precision: 3 }),
  },
  (t) => [
    check('friendships_not_self_chk', sql`${t.requesterId} <> ${t.addresseeId}`), // B-24
    check('friendships_accepted_at_chk', sql`(${t.status} = 'accepted') = (${t.acceptedAt} is not null)`),
    // One row per unordered pair, whichever side asked first (F-51, B-25).
    uniqueIndex('friendships_pair_idx').on(
      sql`least(${t.requesterId}, ${t.addresseeId})`,
      sql`greatest(${t.requesterId}, ${t.addresseeId})`,
    ),
    index('friendships_requester_status_idx').on(t.requesterId, t.status),
    index('friendships_addressee_status_idx').on(t.addresseeId, t.status),
  ],
);
