import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { currentDatabaseUrl } from '../../../../test/database.js';
import type { Database } from '../../../db/client.js';
import * as schema from '../../../db/schema/index.js';
import type { FriendshipReader } from '../../../shared/ports/friendship-reader.js';
import { createFriendshipReader, friendshipPairCondition } from '../friendship-reader.js';

/**
 * The real reader against the file's own migrated database (ADR-0019 §3; F-45, B-52, B-53). Rows are inserted here
 * directly: the generic inserters of `test/db.ts` belong to the test harness wave, and this file must not depend on
 * them. Every query the reader issues is recorded, so the tests can assert "one query" and EXPLAIN the exact SQL.
 */

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

let pool: Pool;
let db: Database;
let reader: FriendshipReader;
let queries: RecordedQuery[];

beforeAll(() => {
  pool = new Pool({ connectionString: currentDatabaseUrl(), max: 2 });
  db = drizzle({
    client: pool,
    schema,
    logger: {
      logQuery: (sql, params) => {
        queries.push({ sql, params });
      },
    },
  });
  reader = createFriendshipReader(db);
});

beforeEach(() => {
  queries = [];
});

afterAll(async () => {
  await pool.end();
});

async function insertUser(firstName: string): Promise<number> {
  const [row] = await db
    .insert(schema.users)
    .values({
      firstName,
      lastName: 'Test',
      email: `${randomUUID()}@example.com`,
      passwordHash: 'not-a-real-hash',
    })
    .returning({ id: schema.users.id });
  return row!.id;
}

async function insertFriendship(requesterId: number, addresseeId: number, status: 'pending' | 'accepted') {
  await db
    .insert(schema.friendships)
    .values({ requesterId, addresseeId, status, acceptedAt: status === 'accepted' ? new Date() : null });
}

/** Two fresh users per test, so no test sees another test's rows. */
async function pair(): Promise<[number, number]> {
  return [await insertUser('Mira'), await insertUser('Jonas')];
}

describe('createFriendshipReader().stateBetween', () => {
  it('F-45: is none for two users without a row', async () => {
    const [mira, jonas] = await pair();
    queries = [];

    await expect(reader.stateBetween(mira, jonas)).resolves.toBe('none');
    await expect(reader.stateBetween(jonas, mira)).resolves.toBe('none');
  });

  it('F-45, B-52: a pending request is outgoing for the requester and incoming for the addressee', async () => {
    const [mira, jonas] = await pair();
    await insertFriendship(mira, jonas, 'pending');

    await expect(reader.stateBetween(mira, jonas)).resolves.toBe('pending_outgoing');
    await expect(reader.stateBetween(jonas, mira)).resolves.toBe('pending_incoming');
  });

  it('F-45: an accepted friendship is friends from both sides, whichever side asked first', async () => {
    const [mira, jonas] = await pair();
    await insertFriendship(jonas, mira, 'accepted');

    await expect(reader.stateBetween(mira, jonas)).resolves.toBe('friends');
    await expect(reader.stateBetween(jonas, mira)).resolves.toBe('friends');
  });

  it("does not leak one pair's row into another pair that shares a user", async () => {
    const [mira, jonas] = await pair();
    const ada = await insertUser('Ada');
    await insertFriendship(mira, jonas, 'accepted');
    await insertFriendship(ada, jonas, 'pending');

    await expect(reader.stateBetween(mira, ada)).resolves.toBe('none');
    await expect(reader.stateBetween(jonas, ada)).resolves.toBe('pending_incoming');
    await expect(reader.stateBetween(jonas, mira)).resolves.toBe('friends');
  });

  it('B-53: answers a value of the shared state enum for every row shape', async () => {
    const [mira, jonas] = await pair();
    const states = [await reader.stateBetween(mira, jonas)];
    await insertFriendship(mira, jonas, 'pending');
    states.push(await reader.stateBetween(mira, jonas), await reader.stateBetween(jonas, mira));

    expect(states).toEqual(['none', 'pending_outgoing', 'pending_incoming']);
  });

  it('is one query per call', async () => {
    const [mira, jonas] = await pair();
    await insertFriendship(mira, jonas, 'pending');
    queries = [];

    await reader.stateBetween(mira, jonas);

    expect(queries).toHaveLength(1);
  });
});

describe('createFriendshipReader().areFriends', () => {
  it('is true only for an accepted friendship, symmetric in both arguments', async () => {
    const [mira, jonas] = await pair();
    await expect(reader.areFriends(mira, jonas)).resolves.toBe(false);

    await insertFriendship(mira, jonas, 'pending');
    await expect(reader.areFriends(mira, jonas)).resolves.toBe(false);
    await expect(reader.areFriends(jonas, mira)).resolves.toBe(false);

    await db
      .update(schema.friendships)
      .set({ status: 'accepted', acceptedAt: new Date() })
      .where(friendshipPairCondition(mira, jonas));
    await expect(reader.areFriends(mira, jonas)).resolves.toBe(true);
    await expect(reader.areFriends(jonas, mira)).resolves.toBe(true);
  });

  it('sees an unfriend on the next call (nothing is cached)', async () => {
    const [mira, jonas] = await pair();
    await insertFriendship(mira, jonas, 'accepted');
    await expect(reader.areFriends(mira, jonas)).resolves.toBe(true);

    await db.delete(schema.friendships).where(friendshipPairCondition(jonas, mira));

    await expect(reader.areFriends(mira, jonas)).resolves.toBe(false);
    await expect(reader.stateBetween(mira, jonas)).resolves.toBe('none');
  });
});

describe('argument guards', () => {
  it('rejects the same user on both sides and non-positive ids without querying', async () => {
    const mira = await insertUser('Mira');
    queries = [];

    await expect(reader.stateBetween(mira, mira)).rejects.toThrow(RangeError);
    await expect(reader.areFriends(mira, mira)).rejects.toThrow(RangeError);
    await expect(reader.areFriends(0, mira)).rejects.toThrow(RangeError);
    await expect(reader.stateBetween(mira, 1.5)).rejects.toThrow(RangeError);
    expect(queries).toHaveLength(0);
  });
});

describe('query plan', () => {
  it("answers from friendships_pair_idx (the pair condition matches the index's expressions)", async () => {
    const [mira, jonas] = await pair();
    await insertFriendship(jonas, mira, 'pending');
    queries = [];
    await reader.stateBetween(mira, jonas);
    const [query] = queries;

    const client = await pool.connect();
    try {
      // The table holds a handful of rows, where a sequential scan is always cheapest; disabling it shows whether the
      // index is usable at all for the reader's exact SQL and parameters.
      await client.query('SET enable_seqscan = off');
      const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${query!.sql}`, query!.params);
      expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain('friendships_pair_idx');
    } finally {
      await client.query('RESET enable_seqscan');
      client.release();
    }
  });
});
