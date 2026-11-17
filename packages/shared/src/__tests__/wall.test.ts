import { describe, expect, it } from 'vitest';

import { CreatePostBody, CreatePostResponse, PageQuery, POST_MAX, WallPage } from '../index.js';

const post = {
  id: 9,
  wallOwnerId: 2,
  author: { id: 3, firstName: 'Mira', lastName: 'Novak', avatarUrl: null },
  body: 'Hello',
  createdAt: '2026-11-15T14:05:00.000Z',
};

describe('CreatePostBody (F-67)', () => {
  it('trims the body', () => {
    expect(CreatePostBody.parse({ body: '  Hello\n' })).toEqual({ body: 'Hello' });
  });

  it.each(['', '   ', '\n\t'])('rejects the empty post %j with a readable message', (body) => {
    const result = CreatePostBody.safeParse({ body });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(['Write something first.']);
  });

  it('accepts 2,000 characters counted after trimming and rejects 2,001', () => {
    expect(POST_MAX).toBe(2000);
    expect(CreatePostBody.safeParse({ body: `  ${'a'.repeat(POST_MAX)}  ` }).success).toBe(true);
    expect(CreatePostBody.safeParse({ body: 'a'.repeat(POST_MAX + 1) }).success).toBe(false);
  });

  it.each([{}, { body: null }, { body: 7 }, { body: ['x'] }])('rejects %j', (input) => {
    expect(CreatePostBody.safeParse(input).success).toBe(false);
  });
});

describe('WallPage and CreatePostResponse', () => {
  it('parse a newest-first page and a created post', () => {
    expect(WallPage.parse({ items: [post], nextCursor: 'abc' })).toEqual({ items: [post], nextCursor: 'abc' });
    expect(WallPage.parse({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null });
    expect(CreatePostResponse.parse({ post })).toEqual({ post });
  });

  it.each(['2026-11-15 14:05:00', '2026-11-15T15:05:00+01:00', 'yesterday'])(
    'rejects the non-UTC-ISO timestamp %j',
    (createdAt) => {
      expect(WallPage.safeParse({ items: [{ ...post, createdAt }], nextCursor: null }).success).toBe(false);
    },
  );

  it('requires nextCursor to be present (null at the end)', () => {
    expect(WallPage.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('PageQuery (ADR-0014)', () => {
  it('defaults the limit to 20', () => {
    expect(PageQuery.parse({})).toEqual({ limit: 20 });
  });

  it('accepts 1 to 50 and an opaque cursor', () => {
    expect(PageQuery.parse({ limit: '50', cursor: 'eyJ0IjoxfQ' })).toEqual({ limit: 50, cursor: 'eyJ0IjoxfQ' });
    expect(PageQuery.parse({ limit: '1' }).limit).toBe(1);
  });

  it.each([{ limit: '0' }, { limit: '51' }, { limit: '1e1' }, { cursor: '' }, { cursor: 'a'.repeat(201) }])(
    'rejects %j',
    (query) => {
      expect(PageQuery.safeParse(query).success).toBe(false);
    },
  );
});
