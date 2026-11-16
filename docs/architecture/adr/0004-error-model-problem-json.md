# ADR-0004: Error model: RFC 9457 problem+json everywhere, 400 vs 422 rule

- Status: accepted (revised after the architecture critique: explicit template deltas, codes typed by the contract)
- Date: 2026-11-15
- Related: B-11, B-12, B-26, B-32, B-33, B-51, B-54, B-55, B-57, F-04, F-10, F-29, F-42, F-46, F-106

## Context

Legacy handlers answered errors with HTTP 200 `{ success: false }` (B-54), hung forever without a response (B-51),
returned Express' HTML error page with stack traces (B-32), relied on TypeErrors for "not found" (B-12, B-55) and
served the SPA shell for unknown API paths (B-57). PLAN.md requires a central RFC 9457 error middleware.

## Decision

- Use `express-feature-module`'s `AppError` hierarchy, `toProblem`, `errorHandler` and `notFoundHandler` with
  `APP_SLUG = 'social-network'`, so `type` is `tag:arnoldovna.github.io,2026:social-network:problem:<code>`, plus
  the deltas listed in BUILD-ORDER 1b, because the template's codes do not match this contract:
  - `UnauthorizedError` → `unauthorized` (template: `unauthenticated`); `BadRequestError` default →
    `invalid-request`; `PayloadTooLargeError` → `file-too-large`; `ConflictError` without a default code;
    new `FileRequiredError` (400 `file-required`, replaces the template's `ValidationError` for a missing file).
  - `toProblem`: csrf-csrf `EBADCSRFTOKEN` → 403 `csrf-invalid` (template: `about:blank`); multer
    `LIMIT_FILE_SIZE` → 413 `file-too-large`, other `MulterError`s → 400 `invalid-request`; other http-errors 4xx
    (body-parser) → `invalid-request` with their status; `instance` without the query string.
  - `ValidationError` takes its status from `validate()` (see below) instead of a hard-wired 400.
  These files are frozen after Phase 1, so the deltas must land there; a Phase 2 unit cannot fix them.
- Codes are an enum in `packages/shared/src/problem.ts`; the client reads them with `problemCode()`. Catalogue in
  API.md §4. `AppError.code` is typed `ProblemCode`, so throwing an unknown code is a type error, and
  `shared/errors/__tests__/problem-codes.test.ts` runs every third-party mapping through `toProblem` and parses
  the result with `ProblemCode`. Without the `csrf-invalid` mapping the SPA's "retry once on 403 `csrf-invalid`"
  would never fire.
- **Validation status rule** (small extension of the template's `validate()`): issues from `params` or `query` →
  400 `invalid-request`; issues only in `body` → 422 `validation-failed`. All issues are reported together in
  `errors[]` (`location`, `path`, `message`). Malformed JSON stays 400 from body-parser.
- Business conflicts (`23505` unique violation) are mapped in the service that knows their meaning
  (`email-taken`, `friendship-exists`). "Zero rows affected" on accept/delete is a 404, never a silent success
  (B-26).
- Repositories return `undefined` for "not found"; services decide 404 vs 403 (B-12). A well-formed id that does not
  exist is 404; a non-numeric id is 400. The web app treats both as "does not exist" on profile pages (F-42).
- Unknown errors: 500 `about:blank` with a generic detail; the stack goes to the log only (F-106). Health endpoints
  never expose dependency details.
- `/api/*` unknown routes → 404 problem (F-04); nginx serves `index.html` only for non-API navigation (B-57).
- Sockets use acknowledgements `{ ok: false, error: { code, message, retryAfterMs? } }` with the codes in
  `realtime.ts`; handlers never throw.

## Alternatives

- **Everything 400** (template default): conflicts with F-29 and F-46, which ask for 422, and hides the difference
  between a broken request and a well-formed but invalid submission.
- **Everything 422**: wrong for path/query parameters, which identify the resource rather than carry content.
- **Custom JSON error envelope**: PLAN.md requires RFC 9457.

## Consequences

- The template deltas above are implemented in Phase 1b and covered by `validate` and `problem-codes` unit tests.
- Frontend error handling is uniform: field errors from `errors[]`, messages from `detail`, behaviour from `code`.
