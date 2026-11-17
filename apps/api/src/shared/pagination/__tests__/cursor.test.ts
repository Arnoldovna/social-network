import { ID_MAX } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { BadRequestError } from '../../errors/app-error.js';
import { type Cursor, decodeCursor, encodeCursor, toPage } from '../cursor.js';

const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString('base64url');

function row(id: number, iso: string): Cursor & { body: string } {
  return { id, createdAt: new Date(iso), body: `post ${String(id)}` };
}

describe('encodeCursor / decodeCursor (ADR-0014)', () => {
  it('round-trips the keyset position with millisecond precision', () => {
    const position = { createdAt: new Date('2026-11-17T09:15:42.123Z'), id: 42 };

    const raw = encodeCursor(position);

    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(raw)).toEqual(position);
  });

  it('accepts the largest int32 id', () => {
    const position = { createdAt: new Date('2026-01-01T00:00:00.000Z'), id: ID_MAX };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it.each([
    ['an empty string', ''],
    ['non-base64url characters', `${encode({ t: '2026-11-17T09:15:42.123Z', id: 1 })}!`],
    ['base64url that is not JSON', Buffer.from('not json').toString('base64url')],
    ['JSON null', encode(null)],
    ['a JSON array', encode(['2026-11-17T09:15:42.123Z', 1])],
    ['a missing id', encode({ t: '2026-11-17T09:15:42.123Z' })],
    ['a missing timestamp', encode({ id: 1 })],
    ['id 0', encode({ t: '2026-11-17T09:15:42.123Z', id: 0 })],
    ['a negative id', encode({ t: '2026-11-17T09:15:42.123Z', id: -1 })],
    ['a fractional id', encode({ t: '2026-11-17T09:15:42.123Z', id: 1.5 })],
    ['a string id', encode({ t: '2026-11-17T09:15:42.123Z', id: '1' })],
    ['an id above int32 (Postgres 22003)', encode({ t: '2026-11-17T09:15:42.123Z', id: ID_MAX + 1 })],
    ['year 0000 (Postgres 22008)', encode({ t: '0000-01-01T00:00:00.000Z', id: 1 })],
    ['a timestamp without milliseconds', encode({ t: '2026-11-17T09:15:42Z', id: 1 })],
    ['a timestamp with microseconds', encode({ t: '2026-11-17T09:15:42.123456Z', id: 1 })],
    ['a timestamp with an offset', encode({ t: '2026-11-17T10:15:42.123+01:00', id: 1 })],
    ['a date only', encode({ t: '2026-11-17', id: 1 })],
    ['an unknown key', encode({ t: '2026-11-17T09:15:42.123Z', id: 1, admin: true })],
  ])('rejects %s with 400 invalid-cursor', (_case, raw) => {
    let error: unknown;
    try {
      decodeCursor(raw);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BadRequestError);
    expect(error).toMatchObject({ status: 400, code: 'invalid-cursor' });
  });
});

describe('toPage', () => {
  const rows = [
    row(5, '2026-11-17T09:00:00.005Z'),
    row(4, '2026-11-17T09:00:00.004Z'),
    row(3, '2026-11-17T09:00:00.004Z'),
  ];

  it('returns `limit` items and a cursor at the last returned item when the extra row exists', () => {
    const page = toPage(rows, 2);

    expect(page.items).toEqual(rows.slice(0, 2));
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor ?? '')).toEqual({ createdAt: rows[1]?.createdAt, id: 4 });
  });

  it('returns no cursor on the last page', () => {
    expect(toPage(rows, 3)).toEqual({ items: rows, nextCursor: null });
    expect(toPage(rows, 10)).toEqual({ items: rows, nextCursor: null });
  });

  it('returns an empty page without a cursor', () => {
    expect(toPage([], 20)).toEqual({ items: [], nextCursor: null });
  });
});
