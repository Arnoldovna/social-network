# ADR-0017: Delivery: Docker images, nginx WebSocket proxy, CI, GHCR release

- Status: accepted (revised after the architecture critique: reproducible images, one-command setup, resource limits;
  CI/release triggers amended by ADR-0018, compose, e2e override, seed and setup details by ADR-0019)
- Date: 2026-11-15
- Related: B-01, B-06, B-08, B-132–B-139, PLAN.md (Tooling, CI, CD, Wartung)

## Context

Legacy ran Node 8 with webpack 1, babel 6 and vulnerable dependencies (B-133), committed `node_modules` and secrets
(B-132, B-01), built into the project root (B-136) and had no CI (B-139). PLAN.md fixes CI (`ci.yml`) and CD
(`release.yml` to GHCR with a disabled deploy job).

## Decision

- Take `project-scaffold`'s CI, release, Dependabot, lefthook, gitleaks, Dockerfiles and compose files as they are.
- Additions for this project:
  - `apps/web/nginx.conf`: `location /socket.io/ { proxy_pass http://api:3000; proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 75s; }`, `client_max_body_size 3m` on `/api/`.
  - nginx `error_page 413 = @too_large` on `/api/` returning `application/problem+json` with the `file-too-large`
    type, so oversized bodies never produce an HTML page.
  - CSP in nginx: `img-src 'self' data: blob:` (blob for the upload preview), `connect-src 'self'`, `script-src
'self'` with **no inline script** in `index.html` (no theme bootstrap, ADR-0015).
  - compose `seed` one-shot service (API image, `dist/db/seed/cli.js`, `SEED_ALLOW: 'true'`, `NODE_ENV` unchanged,
    `SEED_DEMO_PASSWORD: ${SEED_DEMO_PASSWORD:?run pnpm setup:env}` on this service only, so a missing password fails
    with a clear message instead of a vague seed error) between `migrate` and `api`; api env
    `CORS_ORIGINS=http://127.0.0.1:${WEB_PORT:-8080},http://localhost:${WEB_PORT:-8080}` (the socket allow-list must
    follow the published port, ADR-0019 §6), `UPLOAD_MAX_BYTES=2097152`,
    `RATE_LIMIT_MULTIPLIER=${RATE_LIMIT_MULTIPLIER:-1}`, `mem_limit: 768m`.
  - Redis `--maxmemory 128mb --maxmemory-policy volatile-ttl` (sessions and counters have TTLs and are evicted
    first; presence keys have none).
  - `docker-compose.e2e.yml` override: api `RATE_LIMIT_MULTIPLIER: 100` (ADR-0016) and
    `CORS_ORIGINS=http://127.0.0.1:${E2E_PORT:-8183},http://localhost:${E2E_PORT:-8183}`; web
    `ports: !override ['127.0.0.1:${E2E_PORT:-8183}:8080']`; postgres, redis, minio `ports: !reset []`; postgres and
    minio `volumes: !reset []` with tmpfs data. Used only by `scripts/run-e2e.mjs` (compose project
    `social-network-e2e`; root scripts `test:e2e`, `e2e:up`, `e2e:down`; conventions §6; details ADR-0019 §6).
  - `.env.example` gains `SESSION_TTL_DAYS`, `PRESENCE_GRACE_MS`, `RATE_LIMIT_MULTIPLIER` and sets
    `UPLOAD_MAX_BYTES=2097152`, `S3_BUCKET=avatars`, dev `CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173`.
    No `MEDIA_PUBLIC_BASE_URL` in v1 (ADR-0010).
  - **One-command setup**: `pnpm setup:env` (`scripts/setup-env.mjs`) creates `.env` from `.env.example` if it is
    missing, fills exactly the empty secrets `SESSION_SECRET`, `CSRF_SECRET`, `S3_SECRET_ACCESS_KEY`,
    `SEED_DEMO_PASSWORD` (the same script the CI e2e and `dev-setup-smoke` jobs run; `POSTGRES_PASSWORD` stays the
    fixed `local-only`, ADR-0019 §7), and prints the demo login; `pnpm dev:setup` = `setup:env` + `infra:up` +
    `db:migrate` + `db:seed` (idempotent); `pnpm demo` = `node scripts/dev-setup.mjs --demo` (`setup:env` +
    `stack:up` + URL and login); `pnpm stack:down` = `docker compose --profile app down`. The name avoids
    `pnpm setup`, which is a built-in pnpm command. The api `db:seed` script runs `src/db/seed/cli.ts`.
  - **Reproducible images**: every image in compose, the Dockerfiles and Testcontainers (`test/images.ts`) is
    pinned by digest (Chainguard minio/minio-client instead of `:latest`); Dependabot's `docker` and
    `docker-compose` ecosystems propose bumps as reviewable PRs.
  - CI `lint` job: schema drift check (`drizzle-kit generate` + `git diff --exit-code apps/api/drizzle`) and
    `import-x/no-cycle`; CI job `dev-setup-smoke`; `audit.yml` outside the PR checks; `release.yml` on
    `workflow_run` after a successful CI run on `main` (conventions §9). CI cost rule (ADR-0018): `e2e` on pull
    requests only; `images` only for a public repository; `deploy` additionally behind `vars.DEPLOY_ENABLED`;
    releases built from `RELEASE_SHA` (the commit CI tested).
  - Playwright: `retries: 0` locally and in CI, no `webServer` (ADR-0016, conventions §6).
  - API Dockerfile unchanged. `sharp` is imported statically by `shared/uploads/process-image.ts`, so if its
    prebuilt binary failed to load in the distroless runtime the API would not start and the compose healthcheck
    would fail; the avatar E2E test proves the actual re-encoding.
- Images: `ghcr.io/arnoldovna/social-network-api`, `ghcr.io/arnoldovna/social-network-web`.

## Alternatives

- **Serve the SPA from Express**: couples deploys and loses nginx caching/security headers; the template already
  solves same-origin via nginx.
- **Separate WebSocket host**: needs CORS and cross-site cookies; same origin keeps `SameSite=Lax` working.
- **pnpm 12** (`latest`): rejected for v1. PLAN.md only says "pnpm"; the `project-scaffold` templates (lockfile
  settings, `onlyBuiltDependencies`, `pnpm deploy` with `injectWorkspacePackages`) are verified with pnpm 10.34.9,
  and two major versions of behaviour changes would have to be re-verified before Phase 1. Upgrading is a
  separate dependency task after v1, done in the skill first so all three projects move together.
- **Floating image tags** (`:latest`, `18-alpine`): rejected; they change under CI without a commit.

## Consequences

- E2E in CI (on every pull request) exercises the exact production images, nginx and the WebSocket proxy. While the
  repository is private no image is pushed (ADR-0018).
- Deploying later means enabling `vars.DEPLOY_ENABLED`, a hosting target with Postgres, Redis and S3, and TLS
  (then `COOKIE_SECURE` defaults to true).
