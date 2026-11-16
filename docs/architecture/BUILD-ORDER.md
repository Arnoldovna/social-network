# Build order

Matches PLAN.md Etappe 2: **Scaffold (incl. CI/CD) → Backend modules (parallel) → Frontend modules (parallel) →
CSS & Design → Tests/E2E**. Every phase (and each Phase 1 sub-phase) ends with the `quality-gate` skill
(`pnpm verify`, `/code-review high`, `/simplify`, `pnpm verify`, conventional commit on a feature branch, PR,
`gh pr checks --watch`, squash-merge), one branch and one PR per phase or sub-phase
(`project-scaffold/references/conventions.md` §3).

`project-scaffold/references/conventions.md` is binding for everything the three projects share (Phase 0 tools,
repo bootstrap, branches, parallel model, script names, e2e and integration-test isolation, cookie names, digest
pins, CI/audit/release workflows). This file only adds social-network specifics.

Parallel rules (apply to phases 2–5):

1. A unit owns **only** the files listed for it. Everything else is read-only for that unit.
2. Composition files (`apps/api/src/app.ts`, `container.ts`, `server.ts`, `apps/web/src/main.tsx`,
   `apps/web/src/app/router.tsx`, layouts, header) and every feature's `index.ts` **signature** are created in
   Phase 1. Units fill in the body of their own `index.ts` but must not change its exported names or
   parameter/prop types.
3. Frozen after Phase 1: `packages/shared`, `apps/api/src/shared`, `apps/api/src/config`, `apps/api/src/db/schema`,
   `apps/api/src/db/selections.ts`, `apps/api/drizzle`, **`apps/api/test/*`**, `apps/web/src/shared` (incl.
   `shared/test`), `apps/web/src/app/*.ts(x)` (not the `.css` files), `apps/web/src/styles/tokens.css` and
   `styles/main.css`. `styles/{base,utilities}.css`, `shared/ui/*.css` and `app/**/*.css` are frozen after
   Phase 4a (the only phase allowed to change them). A unit that needs a change to a frozen file stops and reports
   it; the orchestrator applies it serially between batches.
4. No new migration and no new dependency inside a parallel phase (migrations and the lockfile are sequential,
   orchestrator only). Units do not commit; the orchestrator runs one quality gate per phase.
5. Each unit ships its unit/integration/component tests with the code (house rule); E2E specs come in Phase 5.
   Test doubles and fixtures a unit needs beyond the generic Phase 1 helpers live in its own
   `__tests__/{fakes,fixtures}.ts`.
6. **Shared local resources.** Parallel units never run `pnpm dev`, `pnpm dev:setup`, `pnpm infra:*`,
   `pnpm stack:*`, `pnpm demo`, `pnpm test:e2e`, `pnpm e2e:*`, any docker compose command or the full
   `pnpm verify`: the dev project `social-network` uses fixed ports 3000, 5173, 5432, 6379, 9000 and 8080, and the
   e2e project `social-network-e2e` is owned by the orchestrator. Units verify with scoped commands only (conventions
   §4): `pnpm exec eslint <own paths>`, `pnpm --filter <pkg> typecheck` (fix only own errors),
   `pnpm exec vitest run --project <unit:… | integration:api> <own paths>` (Testcontainers starts its own containers
   on random ports and every test file gets its own database, so this is isolated). The orchestrator runs the full
   `pnpm verify` once at the gate.

---

## Phase 0 – Machine prerequisites and repository (orchestrator, once; conventions §1, §2)

- Node 26 via fnm (this Mac has 22.20), pnpm 10.34.9 installed under Node 26, git ≥ 2.31 first on `PATH`
  (`/usr/local/bin/git` 2.23 breaks lefthook), Docker Desktop running with Compose ≥ 2.24, gitleaks 8.30.1, `gh`
  logged in as Arnoldovna. Already done if imageboard was built first.
- `git init -b main` in `~/Code/social-network`, docs-only first commit,
  `gh repo create Arnoldovna/social-network --private --source=. --remote=origin --push`.

---

## Phase 1 – Scaffold (sequential, three sub-phases, each with its own gate)

Phase 1 is split so that each gate reviews a diff of reviewable size and a red CI only costs one sub-phase's
3-attempt budget. Branches: 1a `feat/scaffold-tooling`, 1b `feat/scaffold-contracts`, 1c `feat/scaffold-web`.

### Phase 1a – Tooling, CI, contract, runnable skeleton

Source: `project-scaffold/templates/monorepo` + `web-react-variant`, `modular-css-tailwind4`, `maw-design-system`.

| Files | Notes |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `.npmrc` (`engine-strict=true`), `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.js`, `eslint.shared.js`, `stylelint.config.mjs`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.gitignore`, `.dockerignore`, `.gitleaks.toml`, `.gitleaks.dir.toml`, `lefthook.yml`, `lint-staged.config.js`, `commitlint.config.js`, `LICENSE`, `README.md` (stub) | `<slug>` → `social-network`; versions exactly as OVERVIEW §17. Deltas: root scripts `setup:env`, `dev:setup`, `demo`, `test:e2e` (`node scripts/run-e2e.mjs`), `e2e:up`, `e2e:down` (ADR-0017, conventions §5); `eslint.shared.js` adds `import-x/no-cycle` (`eslint-plugin-import-x` 4.18.1, TypeScript resolver) for every package (B-101); `playwright.config.ts` without `webServer`, `baseURL` from the required `E2E_BASE_URL`, `retries: 0` (conventions §6) |
| `scripts/dev-setup.mjs`, `scripts/run-e2e.mjs` | conventions §5, §6: `dev:setup` = tool check → `setup:env` → `infra:up` → `db:migrate` → `db:seed`; `run-e2e.mjs` = compose project `social-network-e2e` with `docker-compose.e2e.yml` on `E2E_PORT` 8183, `up -d --build --wait`, Playwright, `test-results/compose.log` on failure, `down -v` (`--up`/`--down` for `e2e:up`/`e2e:down`) |
| `scripts/setup-env.mjs` | copies `.env.example` to `.env` if absent (never overwrites; adds missing keys), fills every empty secret (`SESSION_SECRET`, `CSRF_SECRET`, `POSTGRES_PASSWORD`, `S3_SECRET_ACCESS_KEY`, `SEED_DEMO_PASSWORD`) with `crypto.randomBytes(32).toString('base64url')` – the same generator the CI e2e step uses – and prints the demo login (`mira.novak@example.com` + the generated password) |
| `.github/actions/setup/action.yml`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/audit.yml`, `.github/dependabot.yml`, `.github/pull_request_template.md` | template (B-139) + deltas: `release.yml` on `workflow_run` after a successful CI run on `main`; `audit.yml` (conventions §9); CI job `dev-setup-smoke` (`pnpm dev:setup` twice, `.env` byte-identical); CI `lint` job adds the schema-drift check `pnpm --filter @app/api exec drizzle-kit generate && git diff --exit-code -- apps/api/drizzle && test -z "$(git status --porcelain -- apps/api/drizzle)"`; the e2e job's throwaway `.env` comes from `node scripts/setup-env.mjs` and it uploads `test-results/` (incl. `compose.log`) on failure; Dependabot adds the `docker` (Dockerfiles) and `docker-compose` ecosystems so digest pins are bumped deliberately |
| `docker-compose.yml`, `docker-compose.e2e.yml` | template + `seed` service, api env (`CORS_ORIGINS`, `UPLOAD_MAX_BYTES`, `SESSION_TTL_DAYS`, `PRESENCE_GRACE_MS`, `RATE_LIMIT_MULTIPLIER: ${RATE_LIMIT_MULTIPLIER:-1}`), `SEED_DEMO_PASSWORD: ${SEED_DEMO_PASSWORD:?run pnpm setup:env}`, api `mem_limit: 768m`, redis `--maxmemory 128mb --maxmemory-policy volatile-ttl`, **every image pinned by digest** (`postgres:18-alpine@sha256:…`, `redis:8-alpine@sha256:…`, Chainguard minio/minio-client by digest instead of `:latest`); `seed` service with `SEED_ALLOW: 'true'` (no `NODE_ENV` override); the e2e override sets `RATE_LIMIT_MULTIPLIER: 100`, `ports: !reset []` and tmpfs data for Postgres/Redis/MinIO, and web on `127.0.0.1:${E2E_PORT:-8183}` (ADR-0016, ADR-0017, conventions §6) |
| `.env.example` | keys from OVERVIEW §13, secrets empty (filled by `pnpm setup:env`), `S3_BUCKET=avatars`, dev `CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173` (B-01, B-03) |
| `apps/api/{package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, vitest.integration.config.ts, drizzle.config.ts, Dockerfile}` | + `sharp`, `socket.io`, dev `socket.io-client`; `db:seed` script (`SEED_ALLOW=true tsx …`) points at `src/db/seed/index.ts` (template points at `src/db/seed.ts`); `drizzle.config.ts` **without** `casing` (DATA-MODEL); `vitest.integration.config.ts`: `include: ['src/**/*.int.test.ts', 'test/**/*.int.test.ts']`, `setupFiles: ['./test/setup-database.ts']` added in 1b together with the per-file database harness (`fileParallelism` stays on; ADR-0016) |
| `apps/api/src/{server,container,app}.ts`, `src/config/{env,app}.ts` | **skeleton only**: template composition with health routes and the problem handlers, no features yet, so the API image builds and `/health/ready` answers; no schema yet (`apps/api/drizzle/meta/_journal.json` with empty `entries`, conventions §3; 1b generates `0000_init.sql`); `src/db/seed/index.ts` stub from 1a on (see 1b) |
| `apps/api/test/{images,global-setup}.ts`, `apps/api/test/health.int.test.ts` | template harness (single migrated database until 1b adds the per-file clone) and one readiness test, so `test:integration` has a file to run (Vitest exits 1 when the selected project has no test files); 1b replaces the harness and folds the test into `app.int.test.ts` |
| `apps/web/{package.json, eslint.config.js, vite.config.ts, vitest.config.ts, tsconfig*.json, Dockerfile, nginx.conf, index.html}` | React variant; + `socket.io-client`, `react-hook-form`, `@hookform/resolvers`, `@fontsource/schibsted-grotesk` (not `-variable`), dev `msw`, dev **`@testing-library/dom` 10.4.2** (peer of RTL and jest-dom, declared explicitly); web ESLint adds the `app` boundaries element; nginx: `/socket.io/` WebSocket location, `client_max_body_size 3m` with `error_page 413 = @too_large` answering `application/problem+json` (`file-too-large`), CSP `img-src 'self' data: blob:` and **no inline script source**; `index.html` with `lang="en"`, charset, viewport and **no inline script** (B-107; no theme bootstrap, ADR-0015) |
| `apps/web/src/main.tsx`, `apps/web/src/styles/{main,tokens,base,utilities}.css` | **skeleton only**: fonts, styles, a placeholder page so the web image builds |
| `packages/shared/{package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts}` | template |
| `packages/shared/src/{index,ids,pagination,problem,user,auth,profile,friendships,wall,chat,presence,uploads,policy,realtime}.ts` + `__tests__/{ids,auth,profile,wall,chat,problem,policy,dto-strictness}.test.ts` | exactly as API.md §1. Covers F-07, F-08, F-09, F-29, F-67, F-78, F-106, F-112 (schemas), B-09, B-53, B-55 (id parsing), B-62 |
| `scripts/check-no-utilities.mjs` | verbatim from `modular-css-tailwind4` |
| `LICENSES/OFL-SchibstedGrotesk.txt` | from the fontsource package |
| `docs/FEATURES.md` | apply the amendments of ADR-0002 (F-09 length, Appendix A/B paths and types, F-68 dropped, label casing note) |
| `e2e/a11y.ts`, `e2e/smoke.spec.ts` | template; smoke: stack is up, `/health/ready` 200, `/` serves `index.html` with `lang="en"`, no CSP violation in the console |

**Gate 1a** (branch `feat/scaffold-tooling`): `pnpm verify` green locally and in CI; release workflow builds both images.

### Phase 1b – API foundations, realtime, test infrastructure

Source: `express-feature-module` templates. "Template" below means the template file with exactly the listed
deltas; everything not listed is copied unchanged except the slug.

| Files | Content |
|---|---|
| `src/server.ts`, `src/container.ts`, `src/app.ts` | template + realtime: container builds `Server` (unattached, `transports: ['websocket']`), `publisher`, `sessionGuard`, socket limiters, `instanceId`, `keyPrefix = APP_SLUG`, `limits = resolveLimits(env)`; app mounts **all** feature modules with the signatures below; server attaches io, runs `presence.onBoot()`, starts the session sweep (60 s), graceful shutdown stops the sweep and closes io first |
| `src/config/env.ts`, `src/config/app.ts`, `src/config/limits.ts` | template + `SESSION_TTL_DAYS`, `PRESENCE_GRACE_MS`, `UPLOAD_MAX_BYTES` default 2 MiB, `RATE_LIMIT_MULTIPLIER` (1–10000, default 1); `APP_SLUG = 'social-network'`; `limits.ts` holds `DEFAULT_LIMITS` (the table in OVERVIEW §10) and `resolveLimits(env)`; `config/__tests__/env.test.ts` |
| `src/db/client.ts`, `src/db/migrate.ts`, `src/db/schema/{index,users,friendships,wall-posts,chat-messages}.ts`, `drizzle/0000_init.sql` + `meta/` | DATA-MODEL.md (explicit column names, `timestamptz(3)`); generated SQL reviewed against its checklist |
| `src/db/selections.ts` | `userSummaryColumns`, `publicUserColumns`, `toUserSummary(row, avatarUrl)`, `toPublicUser` |
| `src/db/seed/index.ts` | stub entry point created in 1a (`SEED_ALLOW` guard + "not implemented yet" log, exit 0), so `dev:setup`, `dev-setup-smoke` and `demo` work from 1a on; filled in Phase 2 |
| `src/shared/errors/app-error.ts` | template **deltas**: `code` is typed `ProblemCode` (from `@app/shared`), so an unknown code is a type error; `UnauthorizedError` → `unauthorized`; `BadRequestError` default → `invalid-request`; `ConflictError` has no default (caller passes `email-taken` / `friendship-exists`); `PayloadTooLargeError` → `file-too-large`; `ValidationError(issues, { status: 400 \| 422 })` with code `invalid-request` for 400 and `validation-failed` for 422; new `FileRequiredError` (400 `file-required`) |
| `src/shared/errors/db-errors.ts`, `auth/*`, `storage/object-storage.ts`, `redis/redis.ts`, `http/health.ts` | template, unchanged except the slug |
| `src/shared/http/problem.ts` | template **deltas**: csrf-csrf `EBADCSRFTOKEN` → 403 `csrf-invalid`; `MulterError` `LIMIT_FILE_SIZE` → 413 `file-too-large`, every other `MulterError` → 400 `invalid-request`; other http-errors 4xx (body-parser) → their status with `invalid-request`; 500 stays `about:blank`; `instance` is `req.baseUrl + req.path` (**no query string**, F-113) |
| `src/shared/http/validate.ts` | template **delta**: issues in params/query → `ValidationError(…, { status: 400 })`, body-only issues → `{ status: 422 }` (ADR-0004) + unit test |
| `src/shared/errors/__tests__/problem-codes.test.ts` | contract test: every `AppError` subclass and every mapping in `toProblem` (multer, csrf, body-parser, rate limit, validation 400/422, file-required) yields a `type` whose code parses with `ProblemCode` |
| `src/shared/security/{session,csrf,security}.ts` | template **deltas**: `bindAnonymousSession` sets `req.session.cookie.maxAge` to 2 h (login regenerates with the normal TTL); `rateLimiter` accepts `skip` and `keyGenerator`; global limiter keyed by `u:<userId>` when a session exists, else `ipKeyGenerator(req.ip ?? '', 56)` (custom key generators ignore `ipv6Subnet`, conventions §8), and skips `GET /api/users/:id/avatar` |
| `src/shared/security/login-limiters.ts` | `createLoginLimiters(limits, stores)`: strict 5 failed / 15 min keyed by `sha256(lower(email)) + ipKeyGenerator(ip, 56)`, ceiling 50 failed / h keyed by `sha256(lower(email))` (ADR-0006) |
| `src/shared/uploads/upload.ts` | template **deltas**: `avatarUpload(field, maxBytes)` with `limits { fileSize, files: 1, fields: 0, parts: 1 }`; `sniffImage` throws `FileRequiredError` when no file arrived |
| `src/shared/uploads/process-image.ts` | `processAvatar(buffer)`: `metadata()` first, reject > 25 Mpx or > 8192 px per side (422), then `sharp(buf, { limitInputPixels: 25_000_000, failOn: 'error', pages: 1 })`; process-wide `sharp.cache(false)`, `sharp.concurrency(1)`, at most 2 concurrent calls (ADR-0010) + unit test incl. a tiny PNG with 16000×16000 px |
| `src/shared/pagination/cursor.ts` | template, unchanged (correct because the cursor columns are `timestamptz(3)`, ADR-0014) |
| `src/shared/logging/logger.ts` | template **delta**: `serializers.req` logs `url` as path only (query string dropped, so `?q=` search terms never reach the log, F-113) |
| `src/shared/media/media-url.ts` | `createAvatarUrl(): AvatarUrl` = `(userId, key) => key ? '/api/users/<id>/avatar?v=<uuid>' : null` (ADR-0010) |
| `src/shared/ports/friendship-reader.ts` | `interface FriendshipReader { stateBetween(me, them): Promise<FriendshipState>; areFriends(a, b): Promise<boolean> }` |
| `src/shared/realtime/{types,rooms,socket-server,socket-auth,publisher,ack,event-limiter,session-guard}.ts` | typed `Server`; `rooms = { user(id), session(sid), wall(ownerId), chat }`; origin check; handshake limiter, auth and per-user socket cap; registrar loop; `RealtimePublisher`; `ack()` helpers; Redis fixed-window `SocketEventLimiter`; `SessionGuard` (per-event check + periodic sweep) |
| `src/features/<x>/index.ts` for auth, users, avatars, friends, wall, chat, presence | **final signatures, stub bodies** (empty `Router()`, no-op registrar, `reader` that returns `'none'`) |
| `test/{images,global-setup,setup-database,database,test-app,fakes,http,socket,db}.ts` | see "Test helpers" below |
| `test/app.int.test.ts`, `test/realtime.int.test.ts` | F-04, F-106, F-109, F-111, F-114; B-07, B-38, B-57, B-59 |
| `src/shared/logging/__tests__/logger.test.ts` | F-113, B-50 (incl. `?q=` stripped) |

Module signatures fixed in Phase 1b (canonical; ADR-0008 and OVERVIEW follow them). Every router is mounted at
`/api` and declares full sub-paths; `requireAuth` is applied per route, never router-wide; auth is mounted at
`/api/auth`:

```ts
createAuthModule(d: { db; hasher; timingDummyHash; requireAuth; authLimiter; loginLimiters: LoginLimiters;
  issueCsrfToken; sessionCookieName; publisher: RealtimePublisher }): { router: Router }
createUsersModule(d: { db; requireAuth; friendships: FriendshipReader; avatarUrl: AvatarUrl;
  searchLimiter }): { router: Router }
createAvatarsModule(d: { db; storage: ObjectStorage; requireAuth; uploadLimiter; maxUploadBytes: number;
  avatarUrl: AvatarUrl; logger: Logger }): { router: Router }
createFriendsModule(d: { db; requireAuth; writeLimiter; publisher: RealtimePublisher;
  avatarUrl: AvatarUrl }): { router: Router; reader: FriendshipReader }
createWallModule(d: { db; requireAuth; writeLimiter; friendships: FriendshipReader;
  publisher: RealtimePublisher; avatarUrl: AvatarUrl; joinLimiter: SocketEventLimiter;
  sessionGuard: SessionGuard }): { router: Router; registerSocket: SocketRegistrar }
createChatModule(d: { db; requireAuth; avatarUrl: AvatarUrl; chatLimiter: SocketEventLimiter;
  sessionGuard: SessionGuard; logger: Logger }): { router: Router; registerSocket: SocketRegistrar }
createPresenceModule(d: { db; redis: RedisClient; keyPrefix: string; requireAuth; avatarUrl: AvatarUrl;
  graceMs: number; instanceId: string; logger: Logger }): { router: Router; registerSocket: SocketRegistrar;
  onBoot(): Promise<void> }

// shared/realtime/types.ts
type SocketRegistrar = (socket: AppSocket, io: AppServer) => void;
interface RealtimePublisher {
  emitToRoom<E extends keyof ServerToClientEvents>(room: string, event: E, ...args: Parameters<ServerToClientEvents[E]>): void;
  leaveRoom(socketsInRoom: string, room: string): void;   // e.g. leaveRoom(rooms.user(a), rooms.wall(b))
  disconnectSession(sessionId: string): void;
}
```

Chat broadcasts `chat:message` from its socket handler through the `io` passed to its registrar
(`io.to(rooms.chat)`), so it needs no publisher. Room names are only ever built with `rooms.*`; no feature writes
a room string by hand.

The friends module is created first in `app.ts` so its `reader` can be passed to users and wall.

#### Test helpers (`apps/api/test`, frozen after Phase 1b)

| File | Content |
|---|---|
| `images.ts` | the digest-pinned Postgres and Redis images (same digests as compose) |
| `global-setup.ts` | Testcontainers Postgres 18 + Redis 8 from `images.ts`, migrates the template database `social_network_template`, closes its connections, provides the admin URL and the Redis URL |
| `setup-database.ts`, `database.ts` | `setupFiles` entry: clones the template per test file (`CREATE DATABASE "t_<random>" TEMPLATE social_network_template`), exposes `currentDatabaseUrl()`, drops it afterwards (`WITH (FORCE)`) (ADR-0016, conventions §7) |
| `test-app.ts` | `createTestApp({ limits?, keyPrefix? })`: real app on the file's database (`currentDatabaseUrl()`) + real io on an ephemeral port, fake storage, silent logger; default `limits = resolveLimits({ RATE_LIMIT_MULTIPLIER: 100 })`; `keyPrefix` (sessions, limiters, presence, socket limiters) defaults to `test-<uuid>`, so `presence.onBoot()` only clears its own namespace |
| `fakes.ts` | generic infra fakes only: object storage, publisher (records emits), friendship reader, fast hasher, clock |
| `http.ts` | agent helpers: `csrf()`, `register()` (unique `<uuid>@example.com`), `login()`, `befriend()` |
| `socket.ts` | `connectAs(agent, { origin? })` → typed socket.io-client with `transports: ['websocket']` and `extraHeaders.origin` (default: the allowed test origin), `waitFor(event)` |
| `db.ts` | typed inserters for all four tables with optional explicit `createdAt`: `insertUser`, `insertFriendship(a, b, status)`, `insertWallPosts(owner, author, n, { createdAt? })`, `insertChatMessages(author, n, { createdAt? })`, each in one statement. **No truncation helper**: every file has its own database, and tests still create their own users and assert on their own rows |

**Gate 1b** (branch `feat/scaffold-contracts`): `pnpm verify` green locally and in CI; integration files demonstrably
run in parallel, each on its own database.

### Phase 1c – Web foundations, E2E infrastructure

| Files | Content |
|---|---|
| `main.tsx` | fonts 400/500, `styles/main.css`, `createRoot`, `RouterProvider`; calls `startSessionListener(store, router.navigate)` and `startRealtimeListener(store)` once (navigation is injected, so `store.ts` never imports the router, B-141) |
| `styles/{main,tokens,base,utilities}.css` | skill templates; accent rose. `utilities.css` is the only owner of `.visually-hidden` and `.skip-link` |
| `app/{store,hooks,router,loaders,realtime-listener,session-listener}.ts(x)` | store with `baseApi` + `realtime` slice + listener middleware; router as ADR-0013 importing pages from feature indexes; loaders import the store, the store imports neither router nor loaders |
| `app/layouts/{AppLayout,WelcomeLayout}.tsx` + `.css` | landmarks, skip link target, header slot, `<Outlet>` |
| `app/header/{SiteHeader,MainNav}.tsx` + `.css` | wordmark, `NavLink`s with `aria-current`, two-row header ≥ 640 px and "menu" disclosure < 640 px (ADR-0015), slots for `HeaderSearch`, `FriendsNavBadge`, `AvatarButton`, `LogoutButton` |
| `app/ConnectionBanner.tsx` + `.css`, `app/pages/{NotFoundPage,RouteErrorPage}.tsx` + `.css` | F-04, F-107 |
| `app/__tests__/{loaders,session-listener,MainNav}.test.tsx` | F-01, F-02, F-22, F-92, F-93, F-94; loaders: a visitor stays on `/welcome` and `/welcome/about` without `reason=expired` and without `sessionExpired`; a logged-in user whose next call returns 401 lands on `/welcome/login?reason=expired` and sees the message exactly once |
| `shared/api/{baseApi,baseQuery,csrf,problem,me.api}.ts` + tests | tag types, CSRF (in-memory token, `clearCsrfToken()`), problem parsing, guarded 401 → `sessionExpired` (ADR-0012); `getMe`, `selectIsAuthenticated` |
| `shared/realtime/{socket,realtimeSlice}.ts` | typed client socket (`transports: ['websocket']`), connect/disconnect, status |
| `shared/session/{session-events,use-current-user}.ts` | |
| `shared/lib/{format-date,names,use-debounced-value,use-confirm}.ts` + tests | en-GB dates, `Intl.RelativeTimeFormat`, initials (F-108) |
| `shared/ui/{Button,TextField,TextArea,FieldError,Dialog,ConfirmDialog,Avatar,UserRow,RelativeTime,LoadingState,ErrorState,EmptyState,Toast}.tsx` + one `.css` each + tests; `shared/ui/{SkipLink,VisuallyHidden}.tsx` + tests (no own CSS, they use the utility classes) | accessible primitives (labels, `aria-describedby`, `aria-invalid`, native `<dialog>` with focus return, `<time datetime>`); `Avatar` falls back to initials on `onError` |
| `shared/test/{setup,render,msw}.ts(x)` | jest-dom, store+router render helper, MSW server |
| `features/<x>/index.ts` for auth, profile, avatars, friends, search, wall, chat, presence | **final exports, stub components** returning a heading or `null` |
| `e2e/fixtures/{api,test,images}.ts` | API user factory with CSRF, `befriend(a, b)`, logged-in page fixture via `storageState`, in-memory image buffers; `test.ts` fails a test on any console message containing "Content Security Policy" |
| `e2e/smoke.spec.ts` | extended: welcome page renders, axe clean, a logged-in page reaches `connected` (socket through nginx) |

Web feature exports fixed in Phase 1c:

```ts
// auth
export { RegisterPage, LoginPage, AboutPage, BrandPanel, LogoutButton }        // LogoutButton(): JSX
// profile
export { OwnProfilePage, UserProfilePage }
// avatars
export { AvatarButton }        // AvatarButton(props: { variant: 'header' | 'profile' })
// friends
export { FriendsPage, FriendButton, FriendsNavBadge }
// FriendButton(props: { userId: number; userName: string; state: FriendshipState })
// search
export { HeaderSearch }
// wall
export { Wall }   // Wall(props: { ownerId: number; ownerFirstName: string; canView: boolean; canPost: boolean })
// chat
export { ChatPage }
// presence
export { OnlinePage }
```

**Gate 1c** (branch `feat/scaffold-web`): `pnpm verify` green locally and in CI.

---

## Phase 2 – Backend modules (parallel; gate at the end)

Prerequisite: Phase 1 merged. Eight units, no shared files. Paths relative to `apps/api/src/`.

| Unit | Files (all new or filling a stub) | FEATURES | BUGS |
|---|---|---|---|
| **auth** | `features/auth/{auth.schema,auth.repository,auth.service,auth.controller,auth.routes,index}.ts`, `__tests__/{auth.service.test,auth.routes.int.test,auth-limits.int.test,fakes}.ts` | F-06–F-10, F-14–F-20, F-23 | B-09–B-18, B-20, B-58 |
| **users** | `features/users/{users.schema,users.repository,users.service,users.controller,users.routes,search-pattern,index}.ts`, `__tests__/{users.service.test,search-pattern.test,users.routes.int.test,fakes}.ts` | F-21, F-28, F-29, F-40–F-43, F-45 (relationship), F-59–F-61, F-64, F-65 (flags) | B-19, B-49, B-55, B-56, B-74, B-76, B-78 |
| **avatars** | `features/avatars/{avatars.repository,avatars.service,avatars.controller,avatars.routes,index}.ts`, `__tests__/{avatars.service.test,avatars.routes.int.test,fakes,fixtures}.ts` | F-36, F-37, F-39 | B-05, B-29–B-37, B-62 |
| **friends** | `features/friends/{friends.schema,friends.repository,friends.service,friends.controller,friends.routes,friendship-state,index}.ts`, `__tests__/{friendship-state.test,friends.service.test,friends.routes.int.test,fakes}.ts` | F-45–F-52, F-54, F-57 (event) | B-24, B-25, B-26, B-27, B-52, B-53 |
| **wall** | `features/wall/{wall.schema,wall.repository,wall.service,wall.controller,wall.routes,wall.socket,index}.ts`, `__tests__/{wall.service.test,wall.routes.int.test,wall.socket.int.test,fakes,fixtures}.ts` | F-65–F-67, F-69–F-72 | B-21, B-22, B-23, B-39, B-40, B-41, B-70, B-72, B-73, B-75 |
| **chat** | `features/chat/{chat.schema,chat.repository,chat.service,chat.controller,chat.routes,chat.socket,index}.ts`, `__tests__/{chat.service.test,chat.routes.int.test,chat.socket.int.test,chat-limits.int.test,fakes,fixtures}.ts` | F-76, F-78, F-79, F-82, F-84, F-85, F-112 | B-42, B-47, B-48, B-73, B-75 |
| **presence** | `features/presence/{presence.store,presence.repository,presence.service,presence.controller,presence.routes,presence.socket,index}.ts`, `__tests__/{presence.service.test,presence.store.int.test,presence.socket.int.test,presence.routes.int.test,fakes}.ts` | F-86–F-88, F-90, F-91 | B-43, B-44, B-45, B-46 |
| **seed** | `db/seed/{index,people,content,avatars}.ts`, `db/seed/__tests__/seed.int.test.ts` | F-115 | B-63 |

Unit notes:
- users and wall receive `FriendshipReader` through deps; their unit tests use the fake from `test/fakes.ts`, so
  they do not wait for the friends unit. Integration tests for users/wall create friendships with
  `test/db.ts#insertFriendship` (not through the friends routes), so they pass even before friends merges.
- Repository fakes, the `PresenceStore` fake and feature fixtures (e.g. wall posts with controlled `createdAt`)
  live in the unit's own `__tests__/{fakes,fixtures}.ts`, never in `test/*`.
- Rate-limit tests (`auth-limits.int.test.ts` for F-16/B-15, `chat-limits.int.test.ts` for F-84) build their own
  app with `createTestApp({ limits: { …low values } })`; every other test runs with the multiplied limits.
- Pagination tests (wall, chat) insert 25 rows **in one statement** (`insertWallPosts`/`insertChatMessages`, so
  they share one `now()`) and page through all of them with `limit=10`: every inserted id appears exactly once, in
  order (ADR-0014). Chat assertions filter on the test's own author.
- wall, chat and presence socket tests use `test/socket.ts`.
- seed's integration test runs in its own per-file database like every other test file; `--reset` therefore only
  ever touches that database.
- Each unit adds `B-xx:` regression tests for its BUGS ids where behaviour is involved (TRACEABILITY.md).

**Gate 2** (branch `feat/backend-modules`).

---

## Phase 3 – Frontend modules (parallel; gate at the end)

Prerequisite: Phase 2 merged (component tests use MSW, so no running API is needed; rule 6 forbids `pnpm dev` in
units). Eight units. Paths relative to `apps/web/src/features/`. Every component gets its CSS file with
structural, token-based rules (the class checker requires defined classes); visual polish follows in Phase 4.

| Unit | Files | FEATURES | BUGS |
|---|---|---|---|
| **auth** | `auth/{auth.api.ts,index.ts}`, `pages/{RegisterPage,LoginPage,AboutPage}.tsx(+css)`, `components/{AuthForm,LogoutButton,BrandPanel}.tsx(+css)`, `__tests__/{RegisterPage.test,LoginPage.test,LogoutButton.test}.tsx` | F-06, F-10–F-14, F-20, F-22 (message), F-95–F-97 | B-18, B-101, B-104, B-105, B-112 |
| **profile** | `profile/{profile.api.ts,index.ts}`, `pages/{OwnProfilePage,UserProfilePage}.tsx(+css)`, `components/{ProfileHeader,BioEditor}.tsx(+css)`, `__tests__/{BioEditor.test,UserProfilePage.test}.tsx` | F-24–F-32, F-40–F-42, F-44 | B-77, B-78, B-82, B-98, B-108 |
| **avatars** | `avatars/{avatars.api.ts,validate-avatar-file.ts,index.ts}`, `components/{AvatarButton,AvatarUploadDialog}.tsx(+css)`, `__tests__/{validate-avatar-file.test.ts,AvatarUploadDialog.test.tsx}` | F-33–F-35, F-37, F-38 | B-96, B-97, B-103 |
| **friends** | `friends/{friends.api.ts,friend-button-labels.ts,index.ts}`, `pages/FriendsPage.tsx(+css)`, `components/{FriendButton,FriendsNavBadge,FriendSection}.tsx(+css)`, `__tests__/{FriendButton.test,FriendsPage.test}.tsx` | F-45, F-49–F-58 | B-26, B-27, B-92, B-93, B-95, B-110 |
| **search** | `search/{search.api.ts,use-combobox.ts,index.ts}`, `components/HeaderSearch.tsx(+css)`, `__tests__/HeaderSearch.test.tsx` | F-59, F-62, F-63 | B-49, B-93, B-94 |
| **wall** | `wall/{wall.api.ts,index.ts}`, `components/{Wall,WallComposer,WallPost,WallPostList}.tsx(+css)`, `__tests__/{Wall.test,WallComposer.test}.tsx` | F-65, F-66 (UI), F-69–F-75 | B-71, B-83, B-86, B-90, B-91, B-99, B-100, B-111 |
| **chat** | `chat/{chat.api.ts,use-stick-to-bottom.ts,index.ts}`, `pages/ChatPage.tsx(+css)`, `components/{ChatLog,ChatMessageItem,ChatComposer}.tsx(+css)`, `__tests__/{ChatComposer.test,ChatLog.test}.tsx` | F-76–F-83, F-85 | B-83, B-84, B-85, B-99, B-111 |
| **presence** | `presence/{presence.api.ts,index.ts}`, `pages/OnlinePage.tsx(+css)`, `__tests__/OnlinePage.test.tsx` | F-86–F-89 | B-46, B-87, B-88, B-89, B-93 |

Unit notes:
- auth: `LogoutButton` disconnects the client socket first (`io client disconnect`), then posts logout, then
  clears the CSRF token, resets the API state and navigates to `/welcome/login` (ADR-0012).
- avatars: after a successful upload the endpoint writes `Me`, invalidates `User` self and the `Chat`, `Wall`,
  `Friendships`, `Presence` tags, so every entry rendered afterwards carries the new URL (F-37, ADR-0010).

Cross-feature imports used here (profile → wall, friends, avatars) resolve to the Phase 1 stubs until the other units
merge; the props are fixed, so the units do not block each other.

**Gate 3** (branch `feat/frontend-modules`).

---

## Phase 4 – CSS & design (4a serial foundation, 4b parallel feature CSS, 4c serial design review; one gate)

Owner: css-architect agents, then design-critic. Only `.css` files and, where a BEM element is missing, the
`className` attributes of the same unit's TSX files.

**4a – foundation + app shell (serial, one unit, runs first).** Explicitly exempt from rule 3 for the files listed
here (and the `className` attributes in `shared/ui/*.tsx` and `app/**/*.tsx`). When 4a is done, its output is
frozen for 4b.

| Unit | Files | FEATURES | BUGS |
|---|---|---|---|
| **foundation + app shell** | `styles/base.css`, `styles/utilities.css` (tokens.css stays verbatim except the accent), `shared/ui/*.css`, `app/**/*.css` | F-93, F-94, F-98, F-99, F-102–F-104 | B-106, B-109, B-113–B-131 (global rules) |

**4b – feature CSS (parallel, after 4a).** Each unit `@reference`s the frozen `main.css` and styles only its own
features.

| Unit | Files | FEATURES | BUGS |
|---|---|---|---|
| **welcome + profile + avatars** | `features/{auth,profile,avatars}/**/*.css` | F-95, F-98 | B-114, B-115, B-121, B-125 |
| **friends + search + presence** | `features/{friends,search,presence}/**/*.css` | F-54, F-58, F-62, F-98 | B-110, B-126, B-130 |
| **wall + chat** | `features/{wall,chat}/**/*.css` | F-69, F-77, F-81, F-98 | B-114, B-131 |

**4c – design review (serial).** Against the seeded demo stack (`pnpm demo`, http://127.0.0.1:8080; never the e2e
stack). `maw-design-system/references/review-rubric.md` on screenshots at 390×844,
768×1024, 1440×900, dark 1440, one hover and one focus state; anti-AI checklist clean, no criterion 0, total ≥ 24/30.
`design-taste-frontend` only as a check lens (copy lint, overflow at 1440/1280/1024/768/640/390/320, tap sizes).
The header must not overflow at 640, 768 and 1024 px (ADR-0015). Fixes in the same phase; the orchestrator
applies fixes to 4a files serially.

**Gate 4** (branch `feat/css-design`).

---

## Phase 5 – Tests / E2E (parallel specs, then a serial audit; gate at the end)

Prerequisite: Phase 4 merged. Fixtures exist since Phase 1c. Each unit owns its spec files only.

Before the units start, the **orchestrator** starts one stack with `pnpm e2e:up` (project `social-network-e2e`,
production images, E2E rate-limit override, `E2E_PORT` 8183). Units run only
`E2E_BASE_URL=http://127.0.0.1:8183 pnpm exec playwright test <own spec files> --output=test-results/<unit> --reporter=list`
against it; they never run `pnpm e2e:*`, `pnpm stack:*`, `pnpm test:e2e`, docker compose or `pnpm verify` (rule 6).
Specs create their own users and assert only on their own content (ADR-0016), so they can share the stack. The
orchestrator runs `pnpm e2e:down` after the units and `pnpm verify` once at the gate.

| Unit | Files | FEATURES |
|---|---|---|
| **routing + auth** | `e2e/routing.spec.ts`, `e2e/auth.spec.ts` | F-01–F-06, F-10–F-14, F-20, F-22 |
| **profile + avatar** | `e2e/profile.spec.ts`, `e2e/avatar.spec.ts` | F-24–F-35, F-37, F-38, F-40–F-42, F-44 |
| **friends + search** | `e2e/friends.spec.ts`, `e2e/search.spec.ts` | F-45, F-49–F-57, F-59, F-62, F-63 |
| **wall** | `e2e/wall.spec.ts` | F-65, F-66, F-69–F-75 |
| **chat + presence** | `e2e/chat.spec.ts`, `e2e/presence.spec.ts` | F-76–F-82, F-85–F-88, F-107, F-111 (socket connects through nginx) |
| **layout + a11y** | `e2e/layout.spec.ts` | F-58, F-92–F-98, F-100–F-105 (incl. header overflow at 640/768/1024) |

Then (serial) the **traceability audit**: for every row in TRACEABILITY.md with a test layer, confirm a test named
`B-xx:` exists and passes; for every F-id in OVERVIEW §14, confirm at least one test references it. Missing tests are
written before the gate. Remove `e2e/smoke.spec.ts` if fully superseded.

**Gate 5** (branch `test/e2e`; Definition of Done from PLAN.md: CI green, all FEATURES met, all BUGS solved, no utility classes, only maw
tokens, gitleaks clean, axe without critical violations). README with screenshots follows in Etappe 3
(`portfolio-readme`).
