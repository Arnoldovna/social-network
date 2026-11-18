import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Exactly the characters `String.prototype.trim` (and so Zod's `.trim()`) removes: ECMAScript WhiteSpace (tab, VT,
 * FF, space, U+00A0, U+FEFF and every other Unicode `Zs` space) and LineTerminator (LF, CR, U+2028, U+2029).
 * Postgres `btrim(x)` strips plain spaces only, so `x = btrim(x)` let `'Ada\n'` through (B-65, DATA-MODEL "Text").
 * Written as ARE character-entry escapes in a plain ASCII string (escaped backslashes, so neither an editor nor a
 * transpiler can turn them into the invisible characters themselves); Postgres reads them the same inside a bracket
 * expression whatever the locale. `schema.test.ts` proves the class matches `trim()` for every BMP code point, and
 * `db/__tests__/constraints.int.test.ts` that Postgres 18 reads it the same way.
 */
export const JS_TRIM_CLASS =
  '[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]';

/** SQL that is true when `column` neither starts nor ends with a character JavaScript's `trim()` would remove. */
export function isTrimmed(column: AnyPgColumn): SQL {
  return sql`${column} !~ ${sql.raw(`'^${JS_TRIM_CLASS}|${JS_TRIM_CLASS}$'`)}`;
}
