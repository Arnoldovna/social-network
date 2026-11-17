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
