# ADR-0001: pnpm monorepo with feature modules on both sides

- Status: accepted
- Date: 2026-11-15
- Related: PLAN.md (Ziel-Architektur, Projekte), B-61, B-101, B-133, B-136, B-138, B-140

## Context

The legacy app is one 468-line `index.js` (config, middleware, routes, sockets) plus `db.js`, a webpack 1 build that
writes `bundle.js` into the project root, and a React 16 client with circular imports (B-61, B-101, B-136, B-138).
PLAN.md fixes the shape for social-network: pnpm monorepo with `apps/web` (React 19 + Vite + Redux Toolkit/RTK Query
+ React Router), `apps/api` (Express 5 + socket.io 4) and `packages/shared` (Zod). The `project-scaffold` and
`express-feature-module` skills provide verified templates for exactly this shape.

## Decision

- Use `project-scaffold/templates/monorepo` with `web-react-variant` over `apps/web`. Workspace scope `@app/*`,
  `APP_SLUG = 'social-network'`.
- API: `src/features/<name>/{schema,repository,service,controller,routes,index}.ts` + `__tests__/`, composition
  root (`server.ts` → `container.ts` → `createApp`) with factory-function DI and no module-level singletons.
  Socket handlers live inside the owning feature (`<name>.socket.ts`) and are registered from its `index.ts`.
- Backend features: `auth`, `users` (me, profiles, search), `avatars` (upload + media), `friends`, `wall`, `chat`,
  `presence`. Cross-feature needs go through ports in `shared/ports` and `shared/realtime`, wired in `app.ts`, so
  backend features have no import-time dependencies on each other.
- Web: `src/app` (router, store, layouts, header, listeners), `src/shared` (api base, socket, ui kit, lib),
  `src/features/<name>/{<name>.api.ts, components/, pages/, index.ts, __tests__/}`. Features: `auth`, `profile`,
  `avatars`, `friends`, `search`, `wall`, `chat`, `presence`.
- `eslint-plugin-boundaries` enforces: features import other features only through `index.ts`; `shared` never imports
  features; web adds an `app` element that may import feature indexes.

## Alternatives

- **Single Express app serving the SPA** (legacy shape): rejected by PLAN.md; also mixes build concerns (B-136).
- **Layered folders (`controllers/`, `services/`, ...)**: scatters one capability over many folders and makes
  parallel building conflict-prone. Feature folders give each builder an exclusive directory.
- **Nx/Turborepo**: unnecessary at three packages; pnpm `-r` with topological order is enough.

## Consequences

- Feature folders can be built in parallel by different agents without touching the same files, provided the
  composition files (`app.ts`, `router.tsx`, layouts) and each feature's `index.ts` signature are created first
  (see BUILD-ORDER.md).
- Feature code is easy to delete or move; boundaries are mechanically checked in CI.
- Slight duplication of small mapping code per feature is accepted over a shared "utils" dumping ground; real shared
  mappings live in `db/selections.ts` (user DTO columns) and `packages/shared`.
