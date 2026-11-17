import { describe, expect, it } from 'vitest';

import { escapeLikePattern, LIKE_ESCAPE, prefixPattern } from '../search-pattern.js';
import { likeToRegExp } from './fakes.js';

describe('escapeLikePattern', () => {
  it('uses the backslash, the escape character the repository declares', () => {
    expect(LIKE_ESCAPE).toBe('\\');
  });

  it('leaves text without LIKE metacharacters unchanged', () => {
    expect(escapeLikePattern('Ada Lovelace')).toBe('Ada Lovelace');
    expect(escapeLikePattern('Zoë-Ann O’Neil')).toBe('Zoë-Ann O’Neil');
  });

  it('B-74: escapes % and _ so they match only themselves', () => {
    expect(escapeLikePattern('50%')).toBe('50\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('%_%')).toBe('\\%\\_\\%');
  });

  it('B-74: escapes the escape character itself, before anything else', () => {
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
    // A backslash in front of a wildcard must not neutralise the wildcard's own escape.
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%');
  });
});

describe('prefixPattern', () => {
  it('F-60: matches the beginning only, by appending a single %', () => {
    expect(prefixPattern('ada')).toBe('ada%');
    expect(prefixPattern('ada lov')).toBe('ada lov%');
  });

  it('does not change the case; Postgres lower() folds both sides', () => {
    expect(prefixPattern('ADA')).toBe('ADA%');
  });

  it('refuses an empty term, which would match every user', () => {
    expect(() => prefixPattern('')).toThrow(RangeError);
  });

  // The same LIKE semantics the fake repository applies, so these cases hold in the unit tests and in Postgres
  // (users.routes.int.test.ts runs the literal-wildcard cases against the real query).
  it.each([
    { term: '50%', name: '50% off', match: true },
    { term: '50%', name: '50x off', match: false },
    { term: 'a_b', name: 'a_bc', match: true },
    { term: 'a_b', name: 'axbc', match: false },
    { term: 'a\\b', name: 'a\\bc', match: true },
    { term: 'a\\b', name: 'ab', match: false },
    { term: 'ada', name: 'ada lovelace', match: true },
    { term: 'ada', name: 'grenada', match: false },
  ])('"$term" against "$name" → $match', ({ term, name, match }) => {
    expect(likeToRegExp(prefixPattern(term)).test(name)).toBe(match);
  });
});

describe('likeToRegExp (fake repository helper)', () => {
  it('rejects a pattern that ends with a lone escape character, as Postgres does', () => {
    expect(() => likeToRegExp('abc\\')).toThrow();
  });

  it('treats regular expression metacharacters literally', () => {
    expect(likeToRegExp('a.c%').test('abc')).toBe(false);
    expect(likeToRegExp('a.c%').test('a.cd')).toBe(true);
  });
});
