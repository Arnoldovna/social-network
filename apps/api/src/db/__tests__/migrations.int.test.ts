import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, DatabaseError, escapeIdentifier, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { databaseUrl } from '../../../test/database.js';

/**
 * The upgrade path of `0001_trim_checks_match_js` (B-65, DATA-MODEL "Migrations"): a database that ran only
 * `0000_init` may hold values its `btrim` checks let through (a trailing line break, a leading no-break space). The
 * migration trims them the way Zod would have before it adds the stricter checks, and a value it cannot repair stops
 * the whole upgrade. Each test migrates its own empty database with drizzle's migrator, exactly as the compose
 * `migrate` service does, first from a copy of the folder that holds only `0000`, then from the real folder.
 */

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));
const CHECK_VIOLATION = '23514';

interface JournalEntry {
  tag: string;
}

let adminUrl: string;
let initOnlyFolder: string;

beforeAll(async () => {
  adminUrl = inject('adminDatabaseUrl');
  initOnlyFolder = await mkdtemp(join(tmpdir(), 'migrations-0000-'));
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  const [init] = journal.entries;
  if (init?.tag !== '0000_init') throw new Error('the first migration in the journal is not 0000_init');
  await mkdir(join(initOnlyFolder, 'meta'));
  await writeFile(join(initOnlyFolder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: [init] }));
  await copyFile(join(MIGRATIONS_FOLDER, `${init.tag}.sql`), join(initOnlyFolder, `${init.tag}.sql`));
});

afterAll(async () => {
  await rm(initOnlyFolder, { recursive: true, force: true });
});

async function asAdmin(statement: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(statement);
  } finally {
    await admin.end();
  }
}

/** Runs `use` with a pool on a new, empty database that is dropped afterwards. */
async function withEmptyDatabase(use: (pool: Pool) => Promise<void>): Promise<void> {
  const name = `m_${randomUUID().replaceAll('-', '')}`;
  await asAdmin(`CREATE DATABASE ${escapeIdentifier(name)}`);
  const pool = new Pool({ connectionString: databaseUrl(adminUrl, name), max: 2 });
  try {
    await use(pool);
  } finally {
    await pool.end();
    await asAdmin(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);
  }
}

function migrateFrom(pool: Pool, migrationsFolder: string): Promise<void> {
  return migrate(drizzle({ client: pool }), { migrationsFolder });
}

const INSERT_USER =
  'insert into users (first_name, last_name, email, password_hash, bio) values ($1, $2, $3, $4, $5) returning id';

async function insertLegacyUser(
  pool: Pool,
  fields: { first: string; last: string; email: string; bio: string | null },
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(INSERT_USER, [
    fields.first,
    fields.last,
    fields.email,
    'not-a-real-hash',
    fields.bio,
  ]);
  const [row] = rows;
  if (!row) throw new Error('insert returned no id');
  return row.id;
}

describe('B-65: upgrading a 0000 database with 0001_trim_checks_match_js', () => {
  it('trims what btrim let through, maps a blank bio to null, keeps clean rows, then enforces the new checks', async () => {
    await withEmptyDatabase(async (pool) => {
      await migrateFrom(pool, initOnlyFolder);
      const email = `ada-${randomUUID()}@example.com`;
      const ada = await insertLegacyUser(pool, {
        first: 'Ada\n',
        last: '\u00A0Lovelace',
        email: `\t${email}`,
        bio: '\u3000Writes notes.\n',
      });
      const blankEmail = `blank-${randomUUID()}@example.com`;
      const blank = await insertLegacyUser(pool, { first: 'Blank', last: 'Bio', email: blankEmail, bio: '\n' });
      const cleanEmail = `grace-${randomUUID()}@example.com`;
      const clean = await insertLegacyUser(pool, {
        first: 'Grace',
        last: 'Hopper',
        email: cleanEmail,
        bio: 'Two\u00A0words\nand a line break inside.',
      });
      await pool.query('insert into wall_posts (wall_owner_id, author_id, body) values ($1, $1, $2)', [ada, 'Hello\n']);
      await pool.query('insert into chat_messages (author_id, body) values ($1, $2)', [ada, '\uFEFFHi there']);

      await migrateFrom(pool, MIGRATIONS_FOLDER);

      const users = await pool.query<{
        id: number;
        first_name: string;
        last_name: string;
        email: string;
        bio: string | null;
      }>('select id, first_name, last_name, email, bio from users order by id');
      expect(users.rows).toEqual([
        { id: ada, first_name: 'Ada', last_name: 'Lovelace', email, bio: 'Writes notes.' },
        { id: blank, first_name: 'Blank', last_name: 'Bio', email: blankEmail, bio: null },
        {
          id: clean,
          first_name: 'Grace',
          last_name: 'Hopper',
          email: cleanEmail,
          bio: 'Two\u00A0words\nand a line break inside.',
        },
      ]);
      expect((await pool.query('select body from wall_posts')).rows).toEqual([{ body: 'Hello' }]);
      expect((await pool.query('select body from chat_messages')).rows).toEqual([{ body: 'Hi there' }]);

      // From now on the stricter checks hold.
      await expect(
        insertLegacyUser(pool, { first: 'Ada\n', last: 'Byron', email: `${randomUUID()}@example.com`, bio: null }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'users_first_name_chk' });
    });
  });

  it('stops and rolls back on a value that is nothing but whitespace, leaving the database at 0000', async () => {
    await withEmptyDatabase(async (pool) => {
      await migrateFrom(pool, initOnlyFolder);
      const author = await insertLegacyUser(pool, {
        first: 'Only',
        last: 'Whitespace',
        email: `${randomUUID()}@example.com`,
        bio: null,
      });
      // `btrim('\n')` is '\n', so 0000 accepted a chat message that Zod would have refused as empty.
      await pool.query('insert into chat_messages (author_id, body) values ($1, $2)', [author, '\n']);

      const failure: unknown = await migrateFrom(pool, MIGRATIONS_FOLDER).then(
        () => {
          throw new Error('the upgrade succeeded, but it should have refused the blank message');
        },
        (error: unknown) => error,
      );
      let cause: unknown = failure;
      while (cause instanceof Error && !(cause instanceof DatabaseError)) cause = cause.cause;
      expect(cause).toBeInstanceOf(DatabaseError);
      expect(cause).toMatchObject({ code: CHECK_VIOLATION, constraint: 'chat_messages_body_chk' });

      // The migration ran in one transaction: nothing of 0001 was applied or recorded, the row is untouched.
      const applied = await pool.query<{ total: number }>(
        'select count(*)::int as total from drizzle.__drizzle_migrations',
      );
      expect(applied.rows).toEqual([{ total: 1 }]);
      expect((await pool.query('select body from chat_messages')).rows).toEqual([{ body: '\n' }]);
      const checks = await pool.query<{ conname: string }>(
        "select conname from pg_constraint where conname = 'users_email_trimmed_chk'",
      );
      expect(checks.rows).toEqual([]);
    });
  });
});
