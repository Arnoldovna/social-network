# ADR-0019: Alignment with the cross-project consistency pass (adversarial re-review)

- Status: accepted (re-review after the consistency pass, 2026-11-17)
- Date: 2026-11-17
- Related: conventions §1 to §9 as applied to social-network; amends ADR-0001, ADR-0005, ADR-0016, ADR-0017,
  BUILD-ORDER.md, OVERVIEW.md §4/§10/§13–§16, DATA-MODEL.md (seed); F-03, F-82, F-107, F-111, F-115; B-07, B-38,
  B-63

## Context

The consistency pass of 2026-11-15 (`project-scaffold/references/conventions.md`) changed rules shared by all three
projects after this architecture had been critiqued: one working tree for all parallel units of a phase, one
database per integration test file, isolated e2e stacks with a fixed port per project (social-network 8183),
app-scoped cookie names, the `SEED_ALLOW` switch, and the CI/audit/release workflows. Since then the project moved to
a new machine (`~`, no `~/Code`), PLAN.md Etappe 0 records the machine prerequisites as done
through `~/.devenv.sh`, and Marina decided a CI cost rule (ADR-0018).

An adversarial re-review of these docs against the new rules found steps that contradicted them or could not be
built as written. Two of them would have failed at the first run:

- The e2e stack now publishes nginx on `127.0.0.1:8183`, but compose still set
  `CORS_ORIGINS=http://127.0.0.1:8080,http://localhost:8080`. The socket handshake's `allowRequest` rejects every
  origin outside that list (ADR-0005), so every WebSocket in every e2e run would have been refused. Verified on
  2026-11-17 with socket.io 4.8 and a raw WebSocket: an allowed origin receives the Engine.IO open packet, an origin
  outside the list gets the upgrade refused.
- `scripts/setup-env.mjs` was to generate `POSTGRES_PASSWORD`, while `DATABASE_URL` in `.env` carries the password
  literally. `pnpm dev`, `pnpm db:migrate` and `pnpm dev:setup` would have failed authentication on the first run.

Each decision below names the problem it removes. The CI cost rule is ADR-0018.

## Decision

### 1. Phase 0 is `~/.devenv.sh`

The script changes nothing on the system, only the current shell. It prepends the newest installed nvm Node 26
(`~/.nvm/versions/node/v26.*`, 26.13.1 on 2026-11-17) and `/opt/homebrew/bin` (git 2.52, gh, docker CLI, gitleaks
8.30.1, lefthook) to `PATH` and exports `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`. `pnpm` is a corepack shim that is already
on the user's `PATH`; corepack runs exactly `package.json#packageManager` (`pnpm@10.34.9`). When the Colima socket
exists, the script points `DOCKER_HOST` at it (Compose 5.5, Colima 4 CPU / 8 GiB on 2026-11-17), sets
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock` and a shell-private `DOCKER_CONFIG`.

Every shell command an agent runs starts with `source ~/.devenv.sh && `. Agents do not install
fnm, Homebrew packages or a global pnpm (`npm i -g`), and do not edit shell rc files. Conventions §1 still describes
fnm and `/usr/local/bin/git`; PLAN.md wins on conflict (flagged for Marina). Playwright browsers are not part of
Phase 0: they need the Playwright version from the lockfile, so phase 1a installs them once
(`pnpm exec playwright install chromium`, no `--with-deps` on macOS). The repository bootstrap (conventions §2) is
done: `main` holds the docs-only commit and `origin` is the private `Arnoldovna/social-network`. Paths in these docs
that pointed at `/Users/marina/Code/...` or `~/Code/...` are corrected.

### 2. One working tree that stays importable

`createTestApp()` builds the real app and `app.ts` imports all seven API modules' `index.ts`; `router.tsx` imports
every web feature's `index.ts`, and some components render other features' public components. With all units of a
phase in one tree (conventions §4), one unit's half-written file can turn every sibling's scoped tests red. Rules
(BUILD-ORDER rule 7):

- A unit writes its internal files first and replaces its stub `index.ts` **last**, after its internal files are
  complete and its own unit tests pass. The new `index.ts` keeps the frozen signature and never throws at import or
  at `create<Name>Module()` time.
- Every file a unit saves must parse (TypeScript, TSX, CSS). Write whole files, not partial drafts.
- A test that renders another feature's public component mocks that feature's `index.ts` with `vi.mock(...)` and a
  trivial stand-in (profile → wall, friends, avatars; the Phase 1c `MainNav.test.tsx` → friends). Without this, the
  test would issue the sibling's real requests the moment the sibling swaps its `index.ts`, and the MSW server
  (`onUnhandledRequest: 'error'`) would fail it.
- A failure caused by a sibling's file is reported to the orchestrator, never fixed by the unit.
- "Frozen" (conventions §4) means every Phase 1 file except those a later unit's file list names explicitly (feature
  `index.ts` stubs, stub components, the seed stubs). Sequential steps between waves are orchestrator-only.

### 3. Parallel units do not wait for each other at runtime

Two runtime dependencies made Phase 2 unbuildable in parallel, regardless of worktrees or one tree:

- **Signing in.** Every non-auth integration test needs an authenticated agent, but `POST /api/auth/register` and
  `/login` are written by the auth unit at the same time (and do not exist at all in Phase 1b, where
  `realtime.int.test.ts` already needs a session). Decision: a **test-only sign-in route**.
  `test/test-routes.ts` builds a router with `POST /__test/sign-in` (JSON `{ userId }`): it checks that the user
  exists (404 otherwise), calls the shared `establishSession(req, userId)` and answers 200 `{ csrfToken }` with a
  token issued for the new session id (non-negotiable 7 of `express-feature-module`). `AppDeps.testRoutes?: Router`
  is mounted by `app.ts` right after `GET /api/csrf-token` and before CSRF protection. Only `createTestApp()` passes
  it; `container.ts` never does. `test/http.ts` exports `signIn(agent, userId)`; users come from
  `test/db.ts#insertUser`. Real `register()`/`login()` helpers stay in `test/http.ts` for the auth unit's own tests.
- **Friendship state.** users (`relationship`, F-45, F-65) and wall (owner-or-friend rules, B-22, B-23) receive the
  friends module's `FriendshipReader`. The friends unit's stub reader answers `'none'` until that unit swaps its
  `index.ts`, so users and wall tests that insert a friendship with `insertFriendship` would fail or pass depending on
  the friends unit's progress. Decision: the **real reader moves to Phase 1b**: `features/friends/friendship-state.ts`
  (derivation table in DATA-MODEL.md) and `features/friends/friendship-reader.ts` (Drizzle, one query on
  `friendships_pair_idx`), with `friendship-state.test.ts` and `friendship-reader.int.test.ts`. The 1b stub
  `index.ts` of friends already returns the real reader; both files are frozen for the friends unit, which may import
  them.

Threat and controls for the test route (ASVS V4 access control, V14 configuration): a test-only endpoint that signs in
any user is an authentication bypass if it ever reaches production. Controls: it lives under `apps/api/test/`,
outside `tsconfig.build.json` (`include: ["src"]`, `rootDir: "src"`), so it is never in `dist/` or the image, and a
`src` file importing it would fail the build; ESLint `no-restricted-imports` bans `test/**` in
every non-test file under `apps/api/src`; `container.ts` has no code path that sets `testRoutes`; and
`test/app.int.test.ts` builds an app without test routes and asserts that `POST /__test/sign-in` answers the 404
problem.

### 4. A phase-1a skeleton that can actually run

`pnpm verify` in 1a runs the schema drift check, migrations (template database and `dev:setup`), the integration
project with the per-file database setup, both production images and an e2e smoke page. The 1a file list therefore
names every file this needs: `src/db/{client,migrate}.ts`, `src/db/schema/index.ts` (`export {};`), the empty
`drizzle/meta/_journal.json`, the shared kernel files the skeleton imports (`shared/{errors,logging,redis}`,
`shared/http/{problem,health}.ts`, `shared/security/security.ts` for headers and CORS), the seed stubs, and the
**final** integration harness (`test/{images,global-setup,setup-database,database,test-app}.ts`). 1b extends
`test-app.ts` and adds the remaining helpers instead of replacing a single-database harness. Petition's merged 1a
(CI green on 2026-11-16) proves the empty schema plus drift check.

- `test/images.ts` reads the `postgres` and `redis` image references (`tag@sha256:…`) from `docker-compose.yml` and
  fails fast when one is missing or not pinned by digest: one source, so a Dependabot `docker-compose` bump reaches
  Testcontainers too (same mechanism as petition).
- `apps/web/vitest.config.ts` points `setupFiles` at `src/shared/test/setup.ts` (the React variant's README says
  `src/test/setup.ts`), and 1a ships that one-line file, so `unit:web` does not reference a missing file until 1c.
- `pnpm format:check` (the first `verify` step) checks `docs/**/*.md`. With Prettier 3.10.1 and the template config,
  18 of the doc files failed it on 2026-11-17. Phase 1a runs `pnpm format` once (layout only); lint-staged keeps
  later edits formatted.
- The template CI e2e steps "Stack logs" and "Tear down" target the dev compose project; they are removed, because
  `scripts/run-e2e.mjs` writes `test-results/compose.log` and always tears its own project down.

### 5. Integration-harness details the per-file database needs

- `currentDatabaseUrl()` (`test/database.ts`) throws outside a test or hook, so `createTestApp()` is called in
  `beforeAll`/`beforeEach`, never at module top level (the file's database does not exist yet).
- `createTestApp({ limits?, keyPrefix?, testRoutes? = true, env? })` returns
  `{ app, httpServer, baseUrl, io, db, redis, prefix, sessionGuard, storage, close }` (amended in Phase 1b: `env`
  overrides `PRESENCE_GRACE_MS`, `UPLOAD_MAX_BYTES`, `SESSION_TTL_DAYS` and `TRUST_PROXY`, validated by the real
  env schema, so presence tests need not wait 5 s per grace period; `storage` is the fake object storage with
  `fail()`/`recover()` for the avatar 500 case). `baseUrl` is the ephemeral
  `http://127.0.0.1:<port>` that `test/socket.ts` connects to; `sessionGuard.sweep()` lets `realtime.int.test.ts`
  trigger the session sweep instead of waiting 60 s (the interval timer lives in `server.ts`, which tests do not
  use). `close()` closes io, the HTTP server, the pool and Redis; the setup file drops the database afterwards
  (Vitest runs `afterAll` hooks in stack order by default, so the drop runs after the file's own `afterAll`;
  `WITH (FORCE)` is the backstop).
- The test origin for sockets (`connectAs`) is part of the test app's `CORS_ORIGINS`.

### 6. The e2e stack really isolates, and its sockets connect

- **`CORS_ORIGINS` follows the published port.** Compose sets the api's allow-list from the same variable as the
  published nginx port: `http://127.0.0.1:${WEB_PORT:-8080},http://localhost:${WEB_PORT:-8080}`;
  `docker-compose.e2e.yml` overrides it with `${E2E_PORT:-8183}`. `scripts/run-e2e.mjs` resolves `E2E_PORT` once
  (process environment, else `.env`, else 8183), validates it, and passes the same value to the compose child
  process and to `E2E_BASE_URL`, so ports and allow-list cannot split.
- Compose concatenates `ports` across files (verified with Compose 5.5 on 2026-11-17: a plain override publishes
  8080 **and** 8183). The override therefore uses `ports: !override ['127.0.0.1:${E2E_PORT:-8183}:8080']` for `web`,
  `ports: !reset []` for postgres, redis and minio (incl. the console port), `volumes: !reset []` with
  `tmpfs: ['/var/lib/postgresql']` (postgres) and `tmpfs: ['/data']` (minio). Needs Compose 2.24.4 or later.
- `run-e2e.mjs` stops with "run `pnpm setup:env`" when `.env` is missing (the stack needs its secrets), runs
  `down -v --remove-orphans` before `up` (leftovers of a killed run) and always afterwards unless `--keep`.
- **The 1c smoke spec cannot log in**: auth routes are stubs until Phase 2, so "a logged-in page reaches
  `connected`" was unbuildable at Gate 1c. Instead the smoke spec opens a raw `WebSocket` from the page to
  `/socket.io/?EIO=4&transport=websocket`, expects the Engine.IO open packet (`0{…}`), sends the namespace connect
  (`40`) and expects `44{"message":"unauthorized"}`. That proves, through the production images, the nginx upgrade
  location, the e2e origin in the allow-list, the CSP `connect-src 'self'` and the anonymous rejection (B-07, B-38).
  "A logged-in page reaches `connected`" moves to Phase 5 (`routing.spec.ts`, F-03; `chat.spec.ts`, F-107, F-111).
- Phase-5 units add `--workers=2` (six units share one machine and one stack). There is no seed-readonly project:
  specs never assert seed counts and never log in as a seeded account, so no `--no-deps` is needed.

### 7. Seed and `.env`

- `SEED_ALLOW` is never an `.env` key and is not in `.env.example`; it is set per invocation by `pnpm db:seed` and by
  the compose `seed` service. `NODE_ENV` is not part of any seed decision. `E2E_BASE_URL` is not in `.env.example`
  either (set by `run-e2e.mjs`).
- **Entry point and logic are split**, so the integration test can run the seed in-process against its own database
  and fake storage: `src/db/seed/cli.ts` is the entry point (`db:seed` =
  `SEED_ALLOW=true tsx --conditions=development --env-file-if-exists=../../.env src/db/seed/cli.ts`; compose `seed`
  runs `dist/db/seed/cli.js`). It reads `process.env` (a tooling entry point), calls `assertSeedAllowed(env)`, validates
  its keys with Zod (key names only on failure), opens the pool and storage, calls `runSeed(deps)` and closes them.
  `src/db/seed/index.ts` exports `assertSeedAllowed` and `runSeed({ db, storage, password, logger, now })` with no
  side effects at import. 1a ships both as stubs (the guard, then "nothing to seed yet", exit 0).
- **No `--reset`.** The first draft refused a destructive reset unless `NODE_ENV` was `development` or `test`, which
  contradicts conventions §8 (never rely on `NODE_ENV`) and protects nothing when a shell has the wrong value.
  The seed only inserts and skips when the demo user exists. Resetting local data is a documented manual command:
  `docker compose --profile app down -v` (drops the Postgres and MinIO volumes), then `pnpm dev:setup`.
- All seed rows are written in one transaction; avatar objects are put before the commit. A failed run leaves no demo
  user, so the next run starts over. Objects a failed run already uploaded stay as unreferenced keys under
  `avatars/`; they are never served (the avatar route serves only the key stored in `users`) and disappear with
  `down -v`.
- `POSTGRES_PASSWORD` keeps the template's fixed local value `local-only` and is not generated (see Context). The
  database listens on `127.0.0.1` only (dev) or is not published at all (e2e). `pnpm dev:setup` stops with a message
  (key names only) when `DATABASE_URL` and `POSTGRES_*` disagree. Generated secrets are exactly the empty keys
  `SESSION_SECRET`, `CSRF_SECRET`, `S3_SECRET_ACCESS_KEY` (also the MinIO root password) and `SEED_DEMO_PASSWORD`.
- `SEED_DEMO_PASSWORD` is passed to the compose `seed` service only, never to `api` (least privilege).

### 8. Scripts and stack ownership

- `demo` = `node scripts/dev-setup.mjs --demo`: tool check, `setup:env`, `pnpm stack:up`, then prints
  `http://127.0.0.1:<WEB_PORT>` and the demo login (the one secret conventions §5 allows to print). A plain compose
  command cannot print anything.
- `stack:down` = `docker compose --profile app down` (no `-v`, conventions §5).
- Only the orchestrator starts or stops a stack: `pnpm demo` / `pnpm stack:down` around the Phase 4c design review,
  `pnpm e2e:up` / `pnpm e2e:down` around Phase 5.

### 9. Cookie names in both modes

Session `__Host-social-network.sid` (secure) / `social-network.sid` (local http); CSRF
`__Host-social-network.x-csrf-token` / `social-network.x-csrf-token`. Integration tests run with
`COOKIE_SECURE=false`, so their session cookie is `social-network.sid` and their CSRF cookie carries the
app slug like every other run (`social-network.x-csrf-token`): `createCsrf({ secret, secure })` builds the name from
`APP_SLUG` (conventions §8), so the template's prefix-based name (`test-<uuid>.x-csrf-token`) is not used (amended
in Phase 1b). Redis keys start with `social-network:` or `test-<uuid>:`.

## Alternatives

- **Build auth (and friends) sequentially before Phase 2**: removes the sign-in and reader problems but lengthens the
  critical path by two units; the test route is a few lines and keeps real login tests in the auth unit. Rejected.
- **Forge a session in Redis plus a signed cookie in test helpers**: no route, but couples tests to express-session's
  storage format and cookie signing internals and needs `cookie-signature` as a new dependency. Rejected.
- **Keep the logged-in smoke check and register through a test route in the production image**: puts an
  authentication bypass into the image. Rejected.
- **Keep `--reset` with a database-name check**: more code for a convenience that `down -v` already provides.
  Rejected.
- **Generate `POSTGRES_PASSWORD` and derive `DATABASE_URL` in `setup-env.mjs`**: more code and still locks out an
  existing `postgres-data` volume whenever `.env` is recreated, for a database that is never reachable from outside
  the machine. Rejected.
- **Hand-kept image constants in `test/images.ts`** (imageboard): works, but Dependabot only bumps compose, so the
  two drift. Rejected.

## Consequences

- BUILD-ORDER.md gains rule 7, a complete 1a list, the 1b test route and reader, the 1c smoke change, and explicit
  stack ownership; OVERVIEW.md §4, §10, §13–§16, §19, DATA-MODEL.md (seed), API.md (infrastructure note), ADR-0005,
  ADR-0016, ADR-0017 and TRACEABILITY.md §13 are updated to match.
- If `.env` is recreated while an old `postgres-data` volume exists, the seeded demo user keeps its old password
  (the seed only inserts). `docker compose --profile app down -v` resets local data; the README "Getting started"
  says so.
- These doc changes are uncommitted on `main`'s working tree. Conventions §2 forbids further commits on `main`, so
  they become the first commit of `feat/scaffold-tooling` (`docs(architecture): align with the consistency pass`).
- Conventions §1 (fnm, `/usr/local/bin/git`, `npm i -g pnpm`) and §9 (no CI cost rule) are stale against PLAN.md and
  ADR-0018 (flagged for Marina; social-network follows PLAN.md and these ADRs meanwhile).
