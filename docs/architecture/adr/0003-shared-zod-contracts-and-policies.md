# ADR-0003: Zod schemas in packages/shared as the single contract, plus shared policies

- Status: accepted (revised after the architecture critique: nested strict DTOs, no id coercion)
- Date: 2026-11-15
- Related: B-09, B-19, B-41, B-47, B-48, B-53, B-62, B-90, F-07–F-11, F-43, F-45, F-90, F-112

## Context

The legacy client and server had no shared types. Validation existed only in the UI (B-09), the server returned UI
labels instead of state (B-53), raw DB rows including password hashes went to clients (B-19), and the real-time post
object carried the wrong id (B-41). The UI decided permissions on its own (B-90) while the server enforced nothing.

## Decision

- `packages/shared/src` holds every request schema, response DTO, enum, limit constant and socket event map (full
  list in API.md §1). `zod` is its only dependency.
- The API validates every HTTP input with `validate({ params, query, body })` and every socket payload with
  `safeParse` against the same schemas. Socket handler payloads are typed `unknown` so the parse cannot be skipped.
- The web app uses the same schemas in react-hook-form (`zodResolver`) and to type RTK Query endpoints. Limits shown
  in the UI (bio counter, upload size) import the constants (`BIO_MAX`, `AVATAR_MAX_BYTES`).
- Response DTOs are built by explicit mappers (`toUserSummary`, `toPublicUser`, `toWallPost`, `toChatMessage`) from
  explicit column selections, never `select *`. Every response DTO is declared with `z.strictObject` at every
  nesting level (Zod's `.strict()` is shallow, so a `.strict()` wrapper in tests would not catch an `email` inside
  `author` or `items[]`). Integration tests simply `Schema.parse(res.body)`; `dto-strictness.test.ts` proves that
  an extra key in a nested object fails and that `.extend()` keeps strictness.
- Ids are never coerced: `IdParam` (`/^[1-9]\d{0,9}$/` → number → `Id`) for path params, plain
  `z.number().int().positive().max(2147483647)` (`Id`) for JSON bodies and socket payloads, `intParam(min, max)`
  for numeric query values. `z.coerce.number()` would accept `true`, `[7]`, `"0x1F"` and `"1e3"`.
- `policy.ts` contains pure permission helpers needed by the UI for rendering decisions (`canDeleteWallPost`). The
  server calls the same helper in the service before its SQL guard; the DB guard (`WHERE author_id = $me OR
wall_owner_id = $me`) remains authoritative.
- Friendship state is an enum (`none | pending_outgoing | pending_incoming | friends`); labels live in the web app
  (`friend-button-labels.ts`).

## Alternatives

- **OpenAPI + code generation**: more tooling and a generated layer to review; Zod already gives runtime validation
  plus types for both sides.
- **tRPC**: would replace REST semantics the FEATURES document specifies (status codes, problem+json, cacheable
  GETs) and does not cover socket events.
- **Server-computed `canDelete` per post** (B-90 suggestion): does not work for broadcast events where every viewer
  needs a different value; the shared policy computes it on each client from `wallOwnerId` and `author.id`.

## Consequences

- A contract change is one edit in `packages/shared`, then type errors guide both apps.
- `packages/shared` must be built before the apps (`pnpm -r build` is topological) and is consumed from source in
  development via the `development` export condition.
- The contract files are written in the scaffold phase so backend and frontend builders work against a frozen
  contract; changes during the module phases need the orchestrator's approval.
