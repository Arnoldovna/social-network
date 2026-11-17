import { describe, expect, it } from 'vitest';

import { BIO_MAX, MeResponse, SearchQuery, SearchResponse, UpdateMeBody } from '../index.js';

describe('UpdateMeBody (F-29)', () => {
  it('trims the bio', () => {
    expect(UpdateMeBody.parse({ bio: '  Hello there.\n' })).toEqual({ bio: 'Hello there.' });
  });

  it.each([
    ['an empty string', ''],
    ['a blank string', '  \n\t '],
    ['null', null],
  ])('stores %s as null', (_label, bio) => {
    expect(UpdateMeBody.parse({ bio })).toEqual({ bio: null });
  });

  it('keeps line breaks inside the bio', () => {
    expect(UpdateMeBody.parse({ bio: 'line one\nline two' })).toEqual({ bio: 'line one\nline two' });
  });

  it('accepts exactly 1,000 characters, counted after trimming', () => {
    expect(BIO_MAX).toBe(1000);
    expect(UpdateMeBody.safeParse({ bio: ` ${'a'.repeat(BIO_MAX)} ` }).success).toBe(true);
  });

  it('rejects 1,001 characters with a readable message', () => {
    const result = UpdateMeBody.safeParse({ bio: 'a'.repeat(BIO_MAX + 1) });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(['Keep your bio under 1,000 characters.']);
  });

  it.each([{}, { bio: 42 }, { bio: ['x'] }])('rejects %j', (body) => {
    expect(UpdateMeBody.safeParse(body).success).toBe(false);
  });
});

describe('SearchQuery (F-60, F-61)', () => {
  it('trims the query and defaults the limit to 10', () => {
    expect(SearchQuery.parse({ q: '  mir ' })).toEqual({ q: 'mir', limit: 10 });
  });

  it('keeps % and _ as literal characters (escaping happens in the repository)', () => {
    expect(SearchQuery.parse({ q: '50%_off' }).q).toBe('50%_off');
  });

  it.each(['', '   '])('rejects the blank query %j', (q) => {
    expect(SearchQuery.safeParse({ q }).success).toBe(false);
  });

  it('accepts 100 characters and rejects 101', () => {
    expect(SearchQuery.safeParse({ q: 'a'.repeat(100) }).success).toBe(true);
    expect(SearchQuery.safeParse({ q: 'a'.repeat(101) }).success).toBe(false);
  });

  it('accepts limits 1 to 20 and nothing else', () => {
    expect(SearchQuery.parse({ q: 'a', limit: '1' }).limit).toBe(1);
    expect(SearchQuery.parse({ q: 'a', limit: '20' }).limit).toBe(20);
    for (const limit of ['0', '21', '1e1', '', '-5']) {
      expect(SearchQuery.safeParse({ q: 'a', limit }).success).toBe(false);
    }
  });

  it('rejects a repeated q, which Express parses into an array', () => {
    expect(SearchQuery.safeParse({ q: ['a', 'b'] }).success).toBe(false);
  });
});

describe('MeResponse and SearchResponse', () => {
  const user = { id: 3, firstName: 'Mira', lastName: 'Novak', avatarUrl: '/api/users/3/avatar?v=x', bio: null };

  it('carry the typed avatarUrl of the upload result (B-62)', () => {
    expect(MeResponse.parse({ user }).user.avatarUrl).toBe('/api/users/3/avatar?v=x');
  });

  it('parse a search result list of summaries', () => {
    const summary = { id: 4, firstName: 'Ana', lastName: 'Lind', avatarUrl: null };
    expect(SearchResponse.parse({ items: [summary] })).toEqual({ items: [summary] });
  });
});
