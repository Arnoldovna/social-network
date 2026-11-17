import { describe, expect, it } from 'vitest';

import { fullName, initials, possessive } from '../names';

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
