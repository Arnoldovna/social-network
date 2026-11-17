/**
 * The escape character of every `LIKE` the users repository builds (`... like <pattern> escape '\'`). Postgres uses
 * backslash by default too; the repository states it explicitly, so the pattern and the query cannot drift apart.
 */
export const LIKE_ESCAPE = '\\';

/** The characters that mean something inside a `LIKE` pattern: the two wildcards and the escape character itself. */
const LIKE_SPECIAL = /[\\%_]/g;

/**
 * Makes user input match itself literally inside a `LIKE` pattern (B-74): `%`, `_` and `\` are prefixed with the
 * escape character. In the legacy query, `%` and `_` in the search box acted as wildcards.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(LIKE_SPECIAL, (special) => `${LIKE_ESCAPE}${special}`);
}

/**
 * The `LIKE` pattern of a prefix search (F-60, B-74): the escaped term followed by one `%`. `term` is the validated,
 * trimmed `SearchQuery.q` (at least one character, so the pattern is never a bare `%` that matches everyone).
 *
 * Case folding is not done here: the repository compares `lower(column)` with `lower(pattern)`, so Postgres folds both
 * sides with the same function and collation (JavaScript's `toLowerCase` can differ from Postgres `lower()` outside
 * ASCII). Lower-casing never touches `%`, `_` or `\`, so the escaping stays intact.
 */
export function prefixPattern(term: string): string {
  if (term.length === 0) throw new RangeError('A prefix search needs at least one character.');
  return `${escapeLikePattern(term)}%`;
}
