# ADR-0020: GitHub Pages live demo with the API mocked in the browser (msw)

- Status: accepted
- Date: 2026-11-18
- Related: PLAN.md "Etappe 3b"; ADR-0003 (shared contract), ADR-0004 (problem+json), ADR-0005 (CSRF, socket
  handshake), ADR-0008 (rooms), ADR-0013 (routing), ADR-0018 (CI cost rule), DATA-MODEL.md "Seed plan"

## Context

GitHub Pages hosts static files only and is free only for public repositories. The demo should still show the real
frontend with live chat and presence, cost nothing, have no cold start, and accept no uploads from strangers (no
moderation or liability question).

## Decision

1. **A second build mode, `demo`** (`pnpm build:demo`, output `apps/web/dist-demo`). `vite.config.ts` switches only
   in that mode: `base: '/social-network/'`, the msw Vite plugin in `worker-only` mode (serves and emits
   `mockServiceWorker.js` under the base), and a small plugin that points `index.html` at `src/demo/entry.ts` and
   copies `index.html` to `404.html` (GitHub Pages' SPA fallback). The router takes `import.meta.env.BASE_URL` as
   its basename. The normal build never references `src/demo` or msw: in every other mode a Vite plugin fails the
   build when an app source imports them, and `scripts/check-demo-build.mjs` proves both
   builds (no msw, no worker, no demo code in `dist`; worker, `404.html` and the base path in `dist-demo`).
2. **The real app, unchanged.** `src/demo/entry.ts` starts the demo and only then imports `main.tsx`, because
   engine.io-client keeps a reference to the global `WebSocket` when its module loads and msw replaces that global.
3. **HTTP through msw** (`setupWorker`, unhandled requests bypassed): `src/demo/http-handlers.ts` maps every endpoint
   of API.md §2 onto `DemoBackend`, which parses every input with the shared Zod schemas (400 `invalid-request` for
   params/query, 422 `validation-failed` with `errors[]` for bodies, as the API's `validate` does) and parses every
   answer with the response schema before it leaves. Failures are problem+json with the API's codes. Sessions,
   CSRF (token in memory, rotated on login/register), friends-only walls, delete rules, cursor pages, search order,
   avatar checks (magic bytes, 2 MB, 8,192 px) follow the API. Rate limits are not simulated.
4. **Realtime through msw's WebSocket interception** with a thin Socket.IO adapter (`socket-io-extension.ts`), an
   msw 3 `WebSocketExtension`: Engine.IO open packet on connect, Socket.IO packets encoded and decoded, the `40`
   handshake answered by `DemoSocketServer` (`connect` with a session, `connect_error: unauthorized` without). The
   open packet announces a ping interval of 2^30 ms, so the mocked server never has to ping. `@mswjs/socket.io-binding`
   was not used: its latest release (0.2.0) targets msw 2 and its interceptors, while this project uses msw 3.
   `DemoSocketServer` implements the rooms of API.md §3 (user, wall, everyone) and the acknowledgements of `chat:send`,
   `wall:join` and `wall:leave`. The link listens on the page's own origin root (`ws:`/`wss:`): msw strips the
   `/socket.io/` prefix from Socket.IO URLs before it matches a link.
5. **Simulated people** (`simulation.ts`): four seeded people are online at the start; every 15–35 s someone goes
   offline or comes online (`presence:*`); a chat message of the visitor is answered 2.5–6 s later by someone online
   (one pending answer at a time); a friend request is accepted 4–9 s later. All of it goes through `DemoBackend`.
6. **Seed and storage.** The pure seed data (people, friendship graph, walls, chat, timeline, avatar designs) moved
   from `apps/api/src/db/seed` to `packages/shared/src/demo-seed`, exported as `@app/shared/demo-seed` (a subpath, so
   the contract entry point and the production bundle stay free of it). The API seed and the demo use the same data,
   PRNG and seed, so the demo shows the same people, posts, chat and avatars. The state is one JSON document in
   IndexedDB (`social-network-demo`), written after every change; uploaded avatars are blobs in a second store. Seeded
   avatars are served as the same SVG designs the API seed rasterises. Passwords are stored as salted SHA-256 (not a
   server-grade hash; the data never leaves the browser). Tabs of one browser stay consistent through a
   `BroadcastChannel` (`sync.ts`): after every save the other tabs adopt the stored state instead of overwriting it
   with an outdated copy. The banner's "reset demo data" (behind a confirmation) stops the simulation, freezes the
   tab's store so nothing in flight writes the old state back, deletes the data, makes the other tabs reload and
   starts again from the seed. Unfriending takes both people out of each other's wall rooms and logging out closes
   the session's sockets, as in the API. When IndexedDB or service workers are unavailable (private windows), the page
   explains that instead of staying blank.
7. **Banner** „Demo – Daten bleiben nur in deinem Browser" (German on purpose, `lang="de"`) with the demo login
   (`mira.novak@example.com`, password `lets-chat-demo`) and "reset demo data", as a flat rose field above the app.
8. **Delivery.** `.github/workflows/pages.yml` builds and deploys only when the repository is public
   (`github.event.repository.private == false`, ADR-0018); build job `pages: read`, deploy job `pages: write` and
   `id-token: write`; actions pinned to SHAs. `ci.yml`'s `build` job builds the demo and runs the build check on every
   run, and a `demo` job (pull requests only, like `e2e`) runs `playwright.demo.config.ts` against `vite preview` of
   the demo the build job built (passed on as an artifact, no second build), with axe.

## Alternatives

- **A hosted API (free tier)**: cold starts, a database and object storage to run, and strangers' uploads to moderate.
- **A recorded video only** (petition's choice): no interaction; social-network's realtime features are the point.
- **Mocking at the RTK Query layer**: would bypass the app's base query, CSRF handling and socket code, so the demo
  would not show the real client.

## Consequences

- Every endpoint or event added to the API needs a demo handler; `DemoBackend` parses with the same schemas, so a
  changed contract fails its unit tests.
- Two tabs of the demo share stored state, but not live socket events: a chat message sent in one tab shows up in the
  other after its next request or reload.
- The demo is only as current as the last deploy from `main` while the repository is public.
