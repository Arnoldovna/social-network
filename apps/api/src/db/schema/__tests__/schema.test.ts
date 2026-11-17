import { randomUUID } from 'node:crypto';

import { BIO_MAX, CHAT_MAX, EMAIL_MAX, NAME_MAX, POST_MAX } from '@app/shared';
import { is } from 'drizzle-orm';
import { getTableConfig, PgDialect, PgTimestamp, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { chatMessages, friendships, friendshipStatus, users, wallPosts } from '../index.js';

// Guards the schema against drifting from DATA-MODEL.md and ADR-0007/ADR-0014. The CI drift check only proves that
// the committed migration matches this schema; these tests prove the schema matches the documented decisions.

const tables = { users, friendships, wallPosts, chatMessages };
const dialect = new PgDialect();

function checkSql(table: PgTable, name: string): string {
  const check = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  if (!check) throw new Error(`check ${name} not found`);
  return dialect.sqlToQuery(check.value).sql;
}

function indexColumns(table: PgTable, name: string) {
  const index = getTableConfig(table).indexes.find((candidate) => candidate.config.name === name);
  if (!index) throw new Error(`index ${name} not found`);
  return index.config.columns;
}

describe('db schema (DATA-MODEL.md)', () => {
  it('defines exactly the four v1 tables with explicit snake_case column names', () => {
    const columnsByTable = Object.fromEntries(
      Object.values(tables).map((table) => {
        const config = getTableConfig(table);
        return [config.name, config.columns.map((column) => column.name)];
      }),
    );

    expect(columnsByTable).toEqual({
      users: [
        'id',
        'first_name',
        'last_name',
        'email',
        'password_hash',
        'bio',
        'avatar_key',
        'created_at',
        'updated_at',
      ],
      friendships: ['id', 'requester_id', 'addressee_id', 'status', 'created_at', 'accepted_at'],
      wall_posts: ['id', 'wall_owner_id', 'author_id', 'body', 'created_at'],
      chat_messages: ['id', 'author_id', 'body', 'created_at'],
    });
  });

  it('stores every timestamp as timestamptz(3), so keyset cursors round-trip exactly (ADR-0014)', () => {
    const timestamps = Object.values(tables).flatMap((table) =>
      getTableConfig(table).columns.filter((column) => is(column, PgTimestamp)),
    );

    expect(timestamps.map((column) => column.name)).toEqual([
      'created_at',
      'updated_at',
      'created_at',
      'accepted_at',
      'created_at',
      'created_at',
    ]);
    for (const column of timestamps) {
      expect(column.getSQLType()).toBe('timestamp (3) with time zone');
    }
  });

  it('uses integer identity primary keys', () => {
    for (const table of Object.values(tables)) {
      const id = getTableConfig(table).columns.find((column) => column.name === 'id');
      expect(id?.primary).toBe(true);
      expect(id?.getSQLType()).toBe('integer');
      expect(id?.generatedIdentity?.type).toBe('always');
    }
  });

  it('cascades every foreign key to users on delete (B-67)', () => {
    const foreignKeys = Object.values(tables).flatMap((table) => getTableConfig(table).foreignKeys);

    expect(foreignKeys.map((foreignKey) => foreignKey.getName()).sort()).toEqual([
      'chat_messages_author_id_users_id_fk',
      'friendships_addressee_id_users_id_fk',
      'friendships_requester_id_users_id_fk',
      'wall_posts_author_id_users_id_fk',
      'wall_posts_wall_owner_id_users_id_fk',
    ]);
    for (const foreignKey of foreignKeys) {
      const { foreignTable, foreignColumns } = foreignKey.reference();
      expect(foreignKey.onDelete).toBe('cascade');
      expect(getTableConfig(foreignTable).name).toBe('users');
      expect(foreignColumns.map((column) => column.name)).toEqual(['id']);
    }
  });

  it('declares the friendship status enum', () => {
    expect(friendshipStatus.enumName).toBe('friendship_status');
    expect(friendshipStatus.enumValues).toEqual(['pending', 'accepted']);
  });
});

describe('keyset indexes (ADR-0014)', () => {
  // ORDER BY created_at DESC, id DESC means NULLS FIRST in Postgres. An index declared DESC NULLS LAST (drizzle's
  // rendering of a bare `.desc()`) cannot deliver that order, and the planner sorts the whole wall or chat instead.
  it.each([
    ['wall_posts_wall_created_idx', wallPosts, ['wall_owner_id', 'created_at', 'id']],
    ['chat_messages_created_idx', chatMessages, ['created_at', 'id']],
  ] as const)('%s matches ORDER BY created_at DESC, id DESC', (name, table, expectedColumns) => {
    const columns = indexColumns(table, name);

    expect(columns.map((column) => ('name' in column ? column.name : undefined))).toEqual(expectedColumns);
    const ordered = columns.slice(-2);
    for (const column of ordered) {
      expect('indexConfig' in column ? column.indexConfig : undefined).toMatchObject({
        order: 'desc',
        nulls: 'first',
      });
    }
  });
});

describe('CHECK constraints mirror the shared Zod limits (B-65)', () => {
  it.each([
    ['users_email_len_chk', users, `between 3 and ${String(EMAIL_MAX)}`],
    ['users_first_name_chk', users, `between 1 and ${String(NAME_MAX)}`],
    ['users_last_name_chk', users, `between 1 and ${String(NAME_MAX)}`],
    ['users_bio_chk', users, `between 1 and ${String(BIO_MAX)}`],
    ['wall_posts_body_chk', wallPosts, `between 1 and ${String(POST_MAX)}`],
    ['chat_messages_body_chk', chatMessages, `between 1 and ${String(CHAT_MAX)}`],
  ] as const)('%s', (name, table, expectedRange) => {
    expect(checkSql(table, name)).toContain(expectedRange);
  });

  it.each([
    ['users_first_name_chk', users, 'btrim("users"."first_name")'],
    ['users_last_name_chk', users, 'btrim("users"."last_name")'],
    ['wall_posts_body_chk', wallPosts, 'btrim("wall_posts"."body")'],
    ['chat_messages_body_chk', chatMessages, 'btrim("chat_messages"."body")'],
  ] as const)('%s rejects untrimmed values', (name, table, expected) => {
    expect(checkSql(table, name)).toContain(expected);
  });
});

describe('users_avatar_key_chk (B-30)', () => {
  // The regex literal inside the CHECK, as Postgres receives it. It only uses syntax that POSIX AREs and JS regexes
  // interpret identically (anchors, classes, a bounded repeat, an escaped dot), so testing it in JS is meaningful.
  const pattern = /'(\^avatars\/.+\$)'/.exec(checkSql(users, 'users_avatar_key_chk'))?.[1];
  const avatarKey = new RegExp(pattern ?? '(?!)');

  it('is a pattern check that allows null', () => {
    expect(pattern).toBeDefined();
    expect(checkSql(users, 'users_avatar_key_chk')).toMatch(/^"users"\."avatar_key" is null or /);
  });

  it("ties the key to the row: its user id segment must be the row's own id", () => {
    expect(checkSql(users, 'users_avatar_key_chk')).toContain(
      `split_part("users"."avatar_key", '/', 2) = "users"."id"::text`,
    );
  });

  it('accepts server-generated keys', () => {
    expect(avatarKey.test(`avatars/7/${randomUUID()}.webp`)).toBe(true);
    expect(avatarKey.test(`avatars/2147483647/${randomUUID()}.webp`)).toBe(true);
  });

  it.each([
    'avatars/7/0f8fad5b-d9cb-469f-a165-70867728950exwebp',
    'avatars/7/0f8fad5b-d9cb-469f-a165-70867728950e.png',
    'avatars/7/../0f8fad5b-d9cb-469f-a165-70867728950e.webp',
    'avatars//0f8fad5b-d9cb-469f-a165-70867728950e.webp',
    'https://bucket.example.com/avatars/7/0f8fad5b-d9cb-469f-a165-70867728950e.webp',
    'avatars/7/0F8FAD5B-D9CB-469F-A165-70867728950E.webp',
    'avatars/7/me.webp',
    'avatars/07/0f8fad5b-d9cb-469f-a165-70867728950e.webp',
    'avatars/7/0f8fad5bd9cb469fa16570867728950e----.webp',
  ])('rejects %s', (key) => {
    expect(avatarKey.test(key)).toBe(false);
  });
});
