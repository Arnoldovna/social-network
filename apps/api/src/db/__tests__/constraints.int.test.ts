import { randomUUID } from 'node:crypto';

import { BIO_MAX, CHAT_MAX, EMAIL_MAX, NAME_MAX, POST_MAX } from '@app/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { DatabaseError, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { currentDatabaseUrl } from '../../../test/database.js';
import { insertChatMessages, insertFriendship, insertUser, insertWallPosts } from '../../../test/db.js';
import type { Database } from '../client.js';
import * as schema from '../schema/index.js';

/**
 * The constraints of `drizzle/0000_init.sql` on the file's own clone of the migrated template database (DATA-MODEL,
 * ADR-0007, ADR-0014). The schema unit test checks how the tables are declared; this file checks what Postgres 18
 * actually enforces, because services rely on it: the pair index makes a reverse-direction request a conflict (B-25),
 * the CHECKs reject what Zod would also reject, and deleting a user cascades. Raw SQL with bound parameters keeps the
 * failing statement visible; each rejection is asserted by SQLSTATE and constraint name.
 */

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

let pool: Pool;
let db: Database;

beforeAll(() => {
  pool = new Pool({ connectionString: currentDatabaseUrl(), max: 2 });
  db = drizzle({ client: pool, schema });
});

afterAll(async () => {
  await pool.end();
});

async function rejection(statement: string, params: unknown[]): Promise<{ code?: string; constraint?: string }> {
  try {
    await pool.query(statement, params);
  } catch (error) {
    if (error instanceof DatabaseError) return { code: error.code, constraint: error.constraint };
    throw error;
  }
  throw new Error(`expected the statement to be rejected: ${statement}`);
}

const INSERT_USER =
  'insert into users (first_name, last_name, email, password_hash, bio, avatar_key) values ($1, $2, $3, $4, $5, $6)';

function userParams(overrides: Partial<Record<'first' | 'last' | 'email' | 'bio' | 'avatarKey', string | null>> = {}) {
  return [
    overrides.first ?? 'Mira',
    overrides.last ?? 'Novak',
    overrides.email ?? `${randomUUID()}@example.com`,
    'not-a-real-hash',
    overrides.bio ?? null,
    overrides.avatarKey ?? null,
  ];
}

describe('users', () => {
  it('rejects an email that is not lower case, too short or too long', async () => {
    expect(await rejection(INSERT_USER, userParams({ email: `${randomUUID()}@Example.com` }))).toEqual({
      code: CHECK_VIOLATION,
      constraint: 'users_email_lowercase_chk',
    });
    expect(await rejection(INSERT_USER, userParams({ email: 'a@' }))).toEqual({
      code: CHECK_VIOLATION,
      constraint: 'users_email_len_chk',
    });
    const tooLong = `${'a'.repeat(EMAIL_MAX - '@example.com'.length + 1)}@example.com`;
    expect(await rejection(INSERT_USER, userParams({ email: tooLong }))).toEqual({
      code: CHECK_VIOLATION,
      constraint: 'users_email_len_chk',
    });
  });

  it('keeps emails unique (the lower(email) index)', async () => {
    const email = `${randomUUID()}@example.com`;
    await pool.query(INSERT_USER, userParams({ email }));
    expect(await rejection(INSERT_USER, userParams({ email }))).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: 'users_email_lower_idx',
    });
  });

  it('rejects empty, untrimmed and over-long names', async () => {
    for (const first of ['', ' Mira', 'Mira ', 'x'.repeat(NAME_MAX + 1)]) {
      expect(await rejection(INSERT_USER, userParams({ first }))).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'users_first_name_chk',
      });
    }
    expect(await rejection(INSERT_USER, userParams({ last: '' }))).toEqual({
      code: CHECK_VIOLATION,
      constraint: 'users_last_name_chk',
    });
    await pool.query(INSERT_USER, userParams({ first: 'x'.repeat(NAME_MAX), last: 'y'.repeat(NAME_MAX) }));
  });

  it('allows a null bio but never an empty or over-long one', async () => {
    for (const bio of ['', 'x'.repeat(BIO_MAX + 1)]) {
      expect(await rejection(INSERT_USER, userParams({ bio }))).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'users_bio_chk',
      });
    }
    await pool.query(INSERT_USER, userParams({ bio: 'x'.repeat(BIO_MAX) }));
  });

  it("accepts only server-made avatar keys of the row's own user (avatars/<id>/<uuid>.webp)", async () => {
    const uuid = randomUUID();
    const user = await insertUser(db);
    const other = await insertUser(db);
    const setAvatar = 'update users set avatar_key = $2 where id = $1';

    await pool.query(setAvatar, [user.id, `avatars/${String(user.id)}/${uuid}.webp`]);
    for (const avatarKey of [
      `avatars/${String(other.id)}/${uuid}.webp`, // another user's key: its URL would serve that user's object
      `avatars/0${String(user.id)}/${uuid}.webp`,
      `avatars/${String(user.id)}/${uuid.replaceAll('-', '')}----.webp`, // 36 hex/dash characters, not a UUID
      `avatars/${String(user.id)}/${uuid}.png`,
      `avatars/../${uuid}.webp`,
      `avatars/${String(user.id)}/${uuid.toUpperCase()}.webp`,
      `avatars/${String(user.id)}/${uuid}xwebp`,
      `https://example.com/avatars/${String(user.id)}/${uuid}.webp`,
      `avatars/${String(user.id)}/${uuid}.webp\n`,
    ]) {
      expect(await rejection(setAvatar, [user.id, avatarKey])).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'users_avatar_key_chk',
      });
    }
    // An insert cannot know its generated id, so it can never carry a valid key.
    expect(await rejection(INSERT_USER, userParams({ avatarKey: `avatars/${String(user.id)}/${uuid}.webp` }))).toEqual({
      code: CHECK_VIOLATION,
      constraint: 'users_avatar_key_chk',
    });
  });

  it('stores created_at with millisecond precision (ADR-0014)', async () => {
    const createdAt = new Date('2026-03-04T05:06:07.045Z');
    const user = await insertUser(db, { createdAt });
    const { rows } = await pool.query<{ micros: string }>(
      `select to_char(created_at at time zone 'UTC', 'US') as micros from users where id = $1`,
      [user.id],
    );
    expect(rows[0]?.micros).toBe('045000');
    expect(user.createdAt.toISOString()).toBe(createdAt.toISOString());
  });
});

describe('friendships', () => {
  const INSERT_REQUEST =
    'insert into friendships (requester_id, addressee_id) values ($1, $2) on conflict do nothing returning id';

  it('allows one row per pair in either direction (B-25)', async () => {
    const [a, b] = await Promise.all([insertUser(db), insertUser(db)]);
    expect((await pool.query(INSERT_REQUEST, [a.id, b.id])).rowCount).toBe(1);
    // The reverse request is a conflict on the pair index, so `on conflict do nothing` returns no row (→ 409).
    expect((await pool.query(INSERT_REQUEST, [b.id, a.id])).rowCount).toBe(0);
    expect((await pool.query(INSERT_REQUEST, [a.id, b.id])).rowCount).toBe(0);
    expect(
      await rejection('insert into friendships (requester_id, addressee_id) values ($1, $2)', [b.id, a.id]),
    ).toEqual({ code: UNIQUE_VIOLATION, constraint: 'friendships_pair_idx' });
  });

  it('rejects a friendship with oneself', async () => {
    const a = await insertUser(db);
    expect(await rejection(INSERT_REQUEST, [a.id, a.id])).toEqual({
      code: CHECK_VIOLATION,
      constraint: 'friendships_not_self_chk',
    });
  });

  it('ties accepted_at to the accepted status', async () => {
    const [a, b, c] = await Promise.all([insertUser(db), insertUser(db), insertUser(db)]);
    const insert = 'insert into friendships (requester_id, addressee_id, status, accepted_at) values ($1, $2, $3, $4)';
    expect(await rejection(insert, [a.id, b.id, 'accepted', null])).toEqual({
      code: CHECK_VIOLATION,
      constraint: 'friendships_accepted_at_chk',
    });
    expect(await rejection(insert, [a.id, b.id, 'pending', new Date()])).toEqual({
      code: CHECK_VIOLATION,
      constraint: 'friendships_accepted_at_chk',
    });
    await pool.query(insert, [a.id, c.id, 'accepted', new Date()]);
  });

  it('rejects an unknown status and an unknown user', async () => {
    const a = await insertUser(db);
    const unknownStatus = await rejection(
      'insert into friendships (requester_id, addressee_id, status) values ($1, $2, $3)',
      [a.id, a.id + 1_000_000, 'blocked'],
    );
    expect(unknownStatus.code).toBe('22P02');
    expect(await rejection(INSERT_REQUEST, [a.id, a.id + 1_000_000])).toEqual({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'friendships_addressee_id_users_id_fk',
    });
  });
});

describe('wall posts and chat messages', () => {
  it('reject empty, untrimmed and over-long bodies', async () => {
    const a = await insertUser(db);
    for (const body of ['', ' hi', 'hi ', 'x'.repeat(POST_MAX + 1)]) {
      expect(
        await rejection('insert into wall_posts (wall_owner_id, author_id, body) values ($1, $1, $2)', [a.id, body]),
      ).toEqual({ code: CHECK_VIOLATION, constraint: 'wall_posts_body_chk' });
    }
    for (const body of ['', 'hi ', 'x'.repeat(CHAT_MAX + 1)]) {
      expect(await rejection('insert into chat_messages (author_id, body) values ($1, $2)', [a.id, body])).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'chat_messages_body_chk',
      });
    }
    await pool.query('insert into wall_posts (wall_owner_id, author_id, body) values ($1, $1, $2)', [
      a.id,
      'x'.repeat(POST_MAX),
    ]);
    await pool.query('insert into chat_messages (author_id, body) values ($1, $2)', [a.id, 'x'.repeat(CHAT_MAX)]);
  });
});

describe('deleting a user', () => {
  it('cascades to friendships, wall posts (as owner and as author) and chat messages', async () => {
    const [gone, friend, other] = await Promise.all([insertUser(db), insertUser(db), insertUser(db)]);
    await insertFriendship(db, gone.id, friend.id, 'accepted');
    await insertFriendship(db, other.id, gone.id, 'pending');
    await insertWallPosts(db, gone.id, friend.id, 2);
    await insertWallPosts(db, friend.id, gone.id, 2);
    await insertWallPosts(db, friend.id, friend.id, 1);
    await insertChatMessages(db, gone.id, 3);
    await insertChatMessages(db, other.id, 1);

    await pool.query('delete from users where id = $1', [gone.id]);

    const count = async (statement: string): Promise<number> => {
      const { rows } = await pool.query<{ n: number }>(statement, [gone.id]);
      return rows[0]?.n ?? -1;
    };
    expect(await count('select count(*)::int as n from friendships where $1 in (requester_id, addressee_id)')).toBe(0);
    expect(await count('select count(*)::int as n from wall_posts where $1 in (wall_owner_id, author_id)')).toBe(0);
    expect(await count('select count(*)::int as n from chat_messages where author_id = $1')).toBe(0);
    // Rows of the other users stay.
    const { rows } = await pool.query<{ n: number }>(
      'select count(*)::int as n from wall_posts where wall_owner_id = $1 and author_id = $1',
      [friend.id],
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe('keyset indexes (ADR-0014)', () => {
  async function plan(statement: string, params: unknown[]): Promise<string> {
    const client = await pool.connect();
    try {
      // A few rows always favour a scan plus a cheap sort. With both discouraged the planner still sorts if no index
      // delivers `created_at DESC, id DESC` (= NULLS FIRST), which is exactly what drizzle's bare `.desc()` (NULLS
      // LAST) would produce, so a Sort node in the plan means the keyset index is unusable for paging.
      await client.query('SET enable_seqscan = off');
      await client.query('SET enable_sort = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${statement}`, params);
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    } finally {
      await client.query('RESET enable_seqscan');
      await client.query('RESET enable_sort');
      client.release();
    }
  }

  it('serve a wall page in index order, without sorting the wall', async () => {
    const owner = await insertUser(db);
    await insertWallPosts(db, owner.id, owner.id, 25);
    const text = await plan(
      `select id from wall_posts where wall_owner_id = $1 and (created_at, id) < ($2, $3)
       order by created_at desc, id desc limit 11`,
      [owner.id, new Date(), 2_147_483_647],
    );
    expect(text).toContain('wall_posts_wall_created_idx');
    expect(text).not.toMatch(/\bSort\b/);
  });

  it('serve a chat page in index order, without sorting the chat', async () => {
    const author = await insertUser(db);
    await insertChatMessages(db, author.id, 25);
    const text = await plan(
      'select id from chat_messages where (created_at, id) < ($1, $2) order by created_at desc, id desc limit 11',
      [new Date(), 2_147_483_647],
    );
    expect(text).toContain('chat_messages_created_idx');
    expect(text).not.toMatch(/\bSort\b/);
  });
});
