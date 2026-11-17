import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import { keysetAfter } from '../keyset.js';
import * as schema from '../schema/index.js';

const { chatMessages, wallPosts } = schema;

// A query builder without a connection: renders SQL only, never talks to a database.
const db = drizzle.mock({ schema });

const cursor = { createdAt: new Date('2026-11-15T14:05:00.123Z'), id: 42 };

describe('keysetAfter (ADR-0014)', () => {
  it('is no condition for the first page', () => {
    expect(keysetAfter({ createdAt: wallPosts.createdAt, id: wallPosts.id }, undefined)).toBeUndefined();
  });

  it('is one typed row comparison with the cursor as bound UTC millisecond timestamp and id', () => {
    const { sql, params } = db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(keysetAfter({ createdAt: chatMessages.createdAt, id: chatMessages.id }, cursor))
      .toSQL();

    expect(sql).toContain('("chat_messages"."created_at", "chat_messages"."id") < ($1::timestamptz, $2::integer)');
    expect(params).toEqual(['2026-11-15T14:05:00.123Z', 42]);
  });
});
