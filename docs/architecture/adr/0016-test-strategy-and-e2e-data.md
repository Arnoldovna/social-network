# ADR-0016: Test strategy and E2E data

- Status: accepted (revised after the architecture critique: test isolation, limits in tests, shared E2E stack;
  harness, sign-in and e2e details amended by ADR-0019, CI trigger by ADR-0018)
- Date: 2026-11-15
- Related: B-139, F-115, PLAN.md (Tests), OVERVIEW.md §14

## Context

The legacy project had no tests at all (B-139). PLAN.md requires Vitest (unit), Supertest + Testcontainers (API),
Playwright + axe (E2E/a11y), all inside `pnpm verify` and CI. This app adds real-time behaviour across several
browsers and presence timing, which HTTP-only tests cannot prove.

## Decision

- **Unit**: Vitest projects `unit:shared`, `unit:api`, `unit:web`. API services with in-memory fakes. Generic
  infra fakes (storage, publisher, friendship reader, fast hasher, clock) live in `apps/api/test/fakes.ts` (Phase
  1b, frozen afterwards); repository fakes, the `PresenceStore` fake and feature fixtures live in each feature's
  `__tests__/{fakes,fixtures}.ts`, owned by that feature's unit. Web components with Testing Library + happy-dom +
  MSW 3.0.5 (handlers built from the shared schemas).
- **Integration**: `integration:api` with Testcontainers Postgres 18 + Redis 8 (global setup migrates a template
  database; every test file gets its own clone), the real `createApp`, a real socket.io server on an ephemeral port,
  `socket.io-client` 4.8.4 (WebSocket transport, explicit `Origin` header), fake object storage.
  Every route: happy path, validation failure, 401, foreign owner 403/404, CSRF 403 (if state-changing). Every
  socket event: valid, invalid payload, unauthenticated, forbidden, rate-limited.
- **Integration isolation** (conventions §7, the same in all three projects; harness complete from Phase 1a):
  - One database per test file: `test/global-setup.ts` migrates `social_network_template`, a `setupFiles` entry
    clones it per file (`CREATE DATABASE … TEMPLATE …`) and drops it afterwards; `fileParallelism` stays on. Global
    tables (chat) therefore start empty in every file, and assertions never race. `createTestApp()` is called in
    `beforeAll`/`beforeEach` (the file's database exists only then) and returns
    `{ app, httpServer, baseUrl, io, db, redis, prefix, sessionGuard, close }` (ADR-0019 §5).
  - Testcontainers images come from `docker-compose.yml` (`test/images.ts`), so a Dependabot bump reaches both.
  - Authenticated agents come from the test-only `POST /__test/sign-in` (`test/http.ts#signIn`), mounted only by
    `createTestApp()`; only the auth unit's own tests register and log in through the real routes (ADR-0019 §3).
  - Every test app gets its own Redis `keyPrefix` (`test-<uuid>`) for sessions, limiters and presence, so
    `presence.onBoot()` only clears its own namespace.
  - No `TRUNCATE`; `test/db.ts` has no truncation helper. Tests still create their own users (unique emails and
    names) and assert on their own rows (chat pagination filters on its own author), so a file can hold many tests.
  - `seed.int.test.ts` calls `runSeed` in-process twice against its own per-file database with the fake storage
    (there is no `--reset`, ADR-0019 §7).
  - Limits: `createTestApp()` uses `RATE_LIMIT_MULTIPLIER` 100; `auth-limits.int.test.ts` (F-16, B-15) and
    `chat-limits.int.test.ts` (F-84) build their own app with low explicit limits.
- **E2E**: Playwright against the production images in the isolated compose project `social-network-e2e`
  (`scripts/run-e2e.mjs`, `E2E_PORT` 8183, conventions §6), projects desktop 1440×900 and mobile
  390×844, `expectNoA11yViolations` on every page state. Real-time journeys use two browser contexts (two users).
  The fixture fails any test whose console shows a CSP violation. The smoke spec (from 1a/1c, before auth exists)
  proves the WebSocket path through nginx with an anonymous raw WebSocket that must be upgraded and then rejected
  with `unauthorized`; `routing.spec`/`chat.spec` prove that a logged-in page reaches `connected` (ADR-0019 §6).
  In CI the e2e job runs on pull requests only (ADR-0018); `pnpm verify` runs it locally at every gate.
- **E2E overrides**: all E2E traffic reaches the API through nginx from one client IP (the Docker gateway, with
  `TRUST_PROXY=1`), and every mutation test registers a fresh user. `docker-compose.e2e.yml` therefore sets
  `RATE_LIMIT_MULTIPLIER=100` for the api service and `CORS_ORIGINS` to the e2e origin
  (`http://127.0.0.1:${E2E_PORT}`), without which the socket allow-list would refuse every e2e browser; production limits are proven by the integration limiter tests,
  not by E2E. A stack started with plain `pnpm stack:up` or `pnpm demo` has production limits and is not used for
  E2E.
- **E2E stack ownership**: `playwright.config.ts` has no `webServer` and requires `E2E_BASE_URL`. `pnpm test:e2e`
  (`scripts/run-e2e.mjs`) resolves `E2E_PORT` once, brings the stack up (after a `down -v` for leftovers), runs
  Playwright and always tears it down (`down -v`); for parallel Phase 5 units the orchestrator runs `pnpm e2e:up`
  once and units run only their own specs against it with `--workers=2` (BUILD-ORDER rule 6, Phase 5).
- **Retries**: `retries: 0` locally and in CI (conventions §6). A flaky real-time test is a failing test and gets a
  root-cause fix; `trace: 'retain-on-failure'` keeps the evidence of the failing attempt.
- **E2E data**:
  - Mutation journeys create their own users through the API (`e2e/fixtures/api.ts`: CSRF token, register with a
    unique `e2e+<uuid>@example.com`, optional friendship) and log in by reusing the returned cookies
    (`storageState`). Tests never depend on each other.
  - Read-only journeys (browse seeded profiles as a fresh user, "load older messages" over the seeded chat history)
    use the seeded demo data from the compose `seed` service without asserting counts and without logging in as a
    seeded account; there is no seed-readonly project. README screenshots use `pnpm demo`, never the e2e stack.
  - Assertions on global state (chat, online list) look for the test's own unique content, never counts.
- **Regression tests for BUGS**: every behavioural BUGS item gets a test named `B-xx: <summary>` in the closest
  layer (TRACEABILITY.md lists the layer).
- Never `.skip`/`.only`, never weaken an assertion or raise a timeout to get green.

## Alternatives

- **Mocking Postgres/Redis in integration tests**: misses SQL, constraint and migration bugs (the exact class of
  legacy bugs B-24/B-25/B-63).
- **E2E against the Vite dev server**: would not exercise nginx, the WebSocket proxy, CSP and the distroless image.
- **Seed-only E2E data**: parallel tests would interfere through shared friendships and walls.

## Consequences

- CI needs Docker for integration and E2E (available on ubuntu runners). Integration first run pulls images
  (`hookTimeout 120 s`).
- `test/http.ts`, `test/socket.ts` and `test/db.ts` (inserters for all four tables with explicit `createdAt`) are
  created in Phase 1b and frozen, so feature builders share them without editing them.
