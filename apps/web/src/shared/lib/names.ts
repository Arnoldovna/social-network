/*
 * Names as people entered them (F-58: stored case, never upper-cased in markup; uppercase styling would be CSS).
 */

export interface PersonName {
  firstName: string;
  lastName: string;
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** The first user-perceived character, so "Élodie" gives "É" and a name starting with an emoji is never split. */
function firstGrapheme(value: string): string {
  for (const { segment } of graphemes.segment(value.trim())) {
    return segment;
  }
  return '';
}

/** "Mira Novak": first and last name, trimmed, one space between (either part may be empty). */
export function fullName({ firstName, lastName }: PersonName): string {
  return [firstName.trim(), lastName.trim()].filter((part) => part !== '').join(' ');
}

/**
 * "MN" for Mira Novak, for the avatar fallback (ADR-0010): the first character of each name, upper-cased with
 * British English rules. "?" when both names are blank, so the fallback field is never empty.
 */
export function initials({ firstName, lastName }: PersonName): string {
  const letters = `${firstGrapheme(firstName)}${firstGrapheme(lastName)}`.toLocaleUpperCase('en-GB');
  return letters === '' ? '?' : letters;
}

/**
 * The possessive for UI copy: "Mira's wall", "Mira Novak's profile picture" (F-101). Always "'s", also after a final
 * s ("James's"), as in British style guides; a trailing space is trimmed first.
 */
export function possessive(name: string): string {
  return `${name.trim()}'s`;
}

/** A person in one of the API's name-ordered lists (search, friends, presence). */
export interface NamedPerson extends PersonName {
  id: number;
}

/** Compares two strings by Unicode code point (not UTF-16 code unit, which differs above U+FFFF). */
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (char) => char.codePointAt(0) ?? 0);
  const right = Array.from(b, (char) => char.codePointAt(0) ?? 0);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

/**
 * The order of every list of people the API sends (`userNameOrder()` in `apps/api/src/db/selections.ts`):
 * `lower(first_name)`, then `lower(last_name)`, then the id. The database compares the lower-cased names by code point
 * (the `en_US.utf8` collation of the musl-based Postgres image does not reorder accents or digits, so "Zoe" comes
 * before "Élodie" and "anna10" before "anna2"), so this does too. A person a socket event adds to a cached list is
 * slotted in exactly where a reload would put them; this is the one client copy of that rule.
 */
export function compareByName(a: NamedPerson, b: NamedPerson): number {
  return (
    compareCodePoints(a.firstName.toLowerCase(), b.firstName.toLowerCase()) ||
    compareCodePoints(a.lastName.toLowerCase(), b.lastName.toLowerCase()) ||
    a.id - b.id
  );
}
