import { Id } from '@app/shared';
import { z } from 'zod';

import { BadRequestError } from '../errors/app-error.js';

// The request schema `PageQuery` (default 20, max 50, no coercion) is part of the shared contract: import it from
// `@app/shared` (ADR-0003, ADR-0014). This file only owns the server side of the cursor.

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Keyset position for `ORDER BY created_at DESC, id DESC`. Correct because the cursor columns are `timestamptz(3)`:
 * the stored value equals the JS `Date`, so no row in the same millisecond is skipped (ADR-0014).
 */
export interface Cursor {
  createdAt: Date;
  id: number;
}

/**
 * Exactly what `encodeCursor` produces: a UTC ISO timestamp with milliseconds and an int32 id. Bounding both keeps a
 * crafted cursor a 400 instead of a Postgres "out of range" 500: ids above int32 overflow `integer` (22003) and year
 * 0000 is valid ISO 8601 but not a Postgres timestamp (22008). No issued cursor ever carries either.
 */
const CursorPayload = z.strictObject({
  t: z.iso.datetime({ precision: 3 }).refine((value) => !value.startsWith('0000-')),
  id: Id,
});

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function encodeCursor({ createdAt, id }: Cursor): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id })).toString('base64url');
}

/** Opaque base64url JSON `{ t, id }`; anything else is 400 `invalid-cursor`, never a 500. */
export function decodeCursor(raw: string): Cursor {
  try {
    // `Buffer.from(…, 'base64url')` silently skips foreign characters; only canonical cursors are accepted.
    if (!BASE64URL.test(raw)) throw new Error('The cursor is not base64url.');
    const payload = CursorPayload.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return { createdAt: new Date(payload.t), id: payload.id };
  } catch {
    throw new BadRequestError('The pagination cursor is invalid.', 'invalid-cursor');
  }
}

/** Repositories fetch `limit + 1` rows; the extra row only signals that another page exists. */
export function toPage<T extends Cursor>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}
