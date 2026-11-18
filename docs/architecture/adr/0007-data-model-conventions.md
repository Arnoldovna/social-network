# ADR-0007: Data model conventions (Drizzle, ids, emails, friendship pair, keys not URLs)

- Status: accepted (revised after the architecture critique: explicit column names, millisecond timestamps, schema-drift check)
- Date: 2026-11-15
- Related: B-05, B-10, B-24, B-25, B-63–B-76, F-08, F-51, F-108, DATA-MODEL.md

## Context

The legacy `social.sql` cannot be re-run (B-63), uses misleading names (B-64), `VARCHAR(500)` without checks (B-65),
no unique pair or self check on friendships (B-24, B-25, B-66), no FK delete behaviour (B-67), no indexes (B-68),
`timestamp` without time zone (B-69), stores full S3 URLs (B-05) and coerces everything with `|| null` (B-76).

## Decision

- Drizzle ORM 0.45.4 + drizzle-kit 0.31.11, **explicit SQL column names** (`text('first_name')`) and no `casing`
  option: nine CHECK and index expressions reference columns inside `sql` templates, and drizzle-kit is known to
  render those wrongly together with `casing: 'snake_case'`. Versioned forward-only migrations committed in
  `apps/api/drizzle/`, applied by a one-shot `migrate` service, never on app boot. CI fails when `drizzle-kit
generate` would produce a migration that is not committed (schema drift check in the `lint` job).
- `integer` identity primary keys (not `bigint`): int32 is ample, JS numbers stay exact, sessions store a number.
- Emails: trimmed and lower-cased by Zod, `CHECK (email = lower(email))`, unique index on `lower(email)`; no
  `citext` extension (fewer moving parts, verified in the template).
- Friendships: one row per unordered pair via a unique expression index on `(least, greatest)`, `CHECK
(requester_id <> addressee_id)`, `friendship_status` enum (`pending`, `accepted`), `accepted_at` consistent with
  status by CHECK. Inserts use `ON CONFLICT DO NOTHING`; zero rows → 409.
- All length and trimming rules from Zod are duplicated as CHECK constraints, so invariants hold for every writer.
- `ON DELETE CASCADE` on every user-owned FK.
- `timestamptz(3)` everywhere (millisecond precision, equal to JS `Date`, so keyset cursors round-trip exactly,
  ADR-0014); display formatting only in the client.
- Object **keys** in the DB (`avatar_key`, pattern-checked), URLs built at read time.
- Repositories take typed, already-validated input and return `undefined` for "not found"; no `|| null` coercion.
- Keyset indexes match every list ordering (ADR-0014); prefix-search indexes use `text_pattern_ops` on
  `lower(...)` expressions.

## Alternatives

- **`citext`**: needs an extension in every database (incl. Testcontainers); the expression index is equivalent.
- **Two rows per friendship (one per direction)**: simpler reads, but doubles writes and needs transactions to keep
  both rows consistent; the pair index makes races impossible by construction.
- **`pg_trgm` for search**: supports infix search, which F-60 does not ask for; prefix btree indexes are smaller.
- **UUID primary keys**: ids are not secret here (all profiles are visible to logged-in users); integers keep URLs
  short.

## Consequences

- The whole schema is defined once in the scaffold phase (`0000_init` migration) so feature modules can be
  built in parallel without migration conflicts. The one later change, `0001_trim_checks_match_js` (after Phase 5,
  B-65), makes the trimming CHECKs refuse exactly what Zod's `.trim()` removes, because `btrim` strips spaces only,
  adds them for `bio` and `email` too, and first trims existing rows the way Zod would have.
- Drizzle's rendering of expression indexes must still be reviewed in the generated SQL (checklist in
  DATA-MODEL.md), but the casing-related failure mode is gone.
- Account deletion (out of scope) would be a single `DELETE FROM users` plus storage cleanup.
