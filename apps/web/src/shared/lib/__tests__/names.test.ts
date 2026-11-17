import { describe, expect, it } from 'vitest';

import { compareByName, fullName, initials, possessive } from '../names';
import type { NamedPerson } from '../names';

describe('fullName', () => {
  it('joins first and last name with one space', () => {
    expect(fullName({ firstName: 'Mira', lastName: 'Novak' })).toBe('Mira Novak');
  });

  it('keeps the stored case (F-58)', () => {
    expect(fullName({ firstName: 'ada', lastName: 'de la Cruz' })).toBe('ada de la Cruz');
  });

  it('trims and skips an empty part', () => {
    expect(fullName({ firstName: '  Jonas ', lastName: '' })).toBe('Jonas');
    expect(fullName({ firstName: '', lastName: ' Okafor' })).toBe('Okafor');
    expect(fullName({ firstName: ' ', lastName: ' ' })).toBe('');
  });
});

describe('initials (avatar fallback, F-108)', () => {
  it('takes the first letter of each name, upper-cased', () => {
    expect(initials({ firstName: 'Mira', lastName: 'Novak' })).toBe('MN');
    expect(initials({ firstName: 'ada', lastName: 'lovelace' })).toBe('AL');
  });

  it('keeps accented letters and combining marks whole', () => {
    expect(initials({ firstName: 'Élodie', lastName: 'Ørsted' })).toBe('ÉØ');
    // "e" + combining acute accent is one user-perceived character.
    expect(initials({ firstName: 'émile', lastName: 'Zola' })).toBe('ÉZ');
  });

  it('never splits an emoji or a surrogate pair', () => {
    expect(initials({ firstName: '👩🏽‍🚀 Sky', lastName: 'Ito' })).toBe('👩🏽‍🚀I');
    expect(initials({ firstName: '𝒜da', lastName: 'Brennan' })).toBe('𝒜B');
  });

  it('ignores leading spaces', () => {
    expect(initials({ firstName: '  jonas', lastName: ' okafor' })).toBe('JO');
  });

  it('uses one initial when only one name is present, and "?" when none is', () => {
    expect(initials({ firstName: 'Mira', lastName: '' })).toBe('M');
    expect(initials({ firstName: ' ', lastName: '' })).toBe('?');
  });
});

describe('possessive', () => {
  it('adds an apostrophe s', () => {
    expect(possessive('Mira')).toBe("Mira's");
    expect(possessive('Mira Novak')).toBe("Mira Novak's");
  });

  it('also after a final s, as in British style', () => {
    expect(possessive('James')).toBe("James's");
  });

  it('trims the name first', () => {
    expect(possessive('Mira ')).toBe("Mira's");
  });
});

describe('compareByName (the API order of every people list)', () => {
  function person(id: number, firstName: string, lastName = 'Novak'): NamedPerson {
    return { id, firstName, lastName };
  }

  function sortedFirstNames(people: NamedPerson[]): string[] {
    return [...people].sort(compareByName).map((entry) => entry.firstName);
  }

  it('orders like `lower(first_name), lower(last_name), id` in the database (code point order)', () => {
    // The order postgres:18-alpine returns for `order by lower(name)` on these values.
    const expected = ['Anna-Lena', 'anna10', 'anna2', 'annabel', 'elodie', 'emma', 'olaf', 'zoe', 'Élodie', 'Ölaf'];
    const shuffled = ['zoe', 'Élodie', 'anna2', 'emma', 'Ölaf', 'Anna-Lena', 'olaf', 'annabel', 'anna10', 'elodie'];

    expect(sortedFirstNames(shuffled.map((name, index) => person(index + 1, name)))).toEqual(expected);
  });

  it('ignores case, then compares the last name, then the id', () => {
    const people = [person(7, 'mira', 'Novak'), person(3, 'Mira', 'novak'), person(5, 'MIRA', 'Adler')];

    expect([...people].sort(compareByName).map((entry) => entry.id)).toEqual([5, 3, 7]);
  });

  it('compares by code point above U+FFFF as well', () => {
    // U+FF21 (fullwidth A) is one UTF-16 unit; U+1D49C (script A) is a surrogate pair that sorts after it by code point.
    expect(sortedFirstNames([person(1, '𝒜da'), person(2, 'Ａda')])).toEqual(['Ａda', '𝒜da']);
  });
});
