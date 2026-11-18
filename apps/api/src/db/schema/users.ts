import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { isTrimmed } from './trimmed.js';

/**
 * Accounts (DATA-MODEL.md, ADR-0007). Every column names its SQL name explicitly and `casing` is not configured, so
 * the `sql` templates of the checks and expression indexes below render exactly as written.
 *
 * Length limits mirror `packages/shared/src/user.ts` (`NAME_MAX`, `EMAIL_MAX`, `BIO_MAX`): Zod trims and checks on
 * the way in, the CHECK constraints keep the invariant for every other writer (seed, future scripts), B-65. "Trimmed" means
 * what JavaScript's `trim()` means (`trimmed.ts`), not Postgres `btrim`.
 */
export const users = pgTable(
  'users',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    bio: text('bio'),
    avatarKey: text('avatar_key'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Case-insensitive uniqueness without the citext extension (ADR-0007). Emails are stored lower-cased anyway.
    uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`),
    check('users_email_lowercase_chk', sql`${t.email} = lower(${t.email})`),
    check('users_email_trimmed_chk', isTrimmed(t.email)),
    check('users_email_len_chk', sql`char_length(${t.email}) between 3 and 254`),
    check('users_first_name_chk', sql`char_length(${t.firstName}) between 1 and 100 and ${isTrimmed(t.firstName)}`),
    check('users_last_name_chk', sql`char_length(${t.lastName}) between 1 and 100 and ${isTrimmed(t.lastName)}`),
    // NULL means "no bio". An empty string is never stored (Zod maps '' to null).
    check('users_bio_chk', sql`${t.bio} is null or (char_length(${t.bio}) between 1 and 1000 and ${isTrimmed(t.bio)})`),
    // Only server-generated keys of this very row can ever be stored (B-30): exactly the shape `newAvatarKey(id)`
    // builds (`shared/media/media-url.ts`: no leading zero, a lowercase UUID) and the row's own id as the key's user, so
    // `createAvatarUrl` can never meet a stored key it refuses. `\\.` in the template is `\.` in SQL: a literal dot.
    check(
      'users_avatar_key_chk',
      sql`${t.avatarKey} is null or (${t.avatarKey} ~ '^avatars/[1-9][0-9]*/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.webp$' and split_part(${t.avatarKey}, '/', 2) = ${t.id}::text)`,
    ),
    // Prefix search (F-60): LIKE 'abc%' on lower(...) can use a text_pattern_ops btree index.
    index('users_first_name_prefix_idx').using('btree', sql`lower(${t.firstName}) text_pattern_ops`),
    index('users_last_name_prefix_idx').using('btree', sql`lower(${t.lastName}) text_pattern_ops`),
    index('users_full_name_prefix_idx').using(
      'btree',
      sql`(lower(${t.firstName} || ' ' || ${t.lastName})) text_pattern_ops`,
    ),
  ],
);
