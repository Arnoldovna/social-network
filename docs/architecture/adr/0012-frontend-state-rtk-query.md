# ADR-0012: Frontend state: RTK Query for server state, sockets patch the cache

- Status: accepted (revised after the architecture critique: guarded session expiry, injected navigation, CSRF token lifecycle, avatar freshness)
- Date: 2026-11-15
- Related: B-77, B-82, B-83, B-86, B-87, B-89, B-91, B-92, B-95, B-97, B-141, F-22, F-25, F-35, F-53, F-57, F-73, F-80, F-105

## Context

Legacy state was a hand-written reducer with string action types, spreading `undefined` on early events (B-86), one
global `posts` array for whichever wall was open (B-91), two unsynchronised sources of truth for friendships (B-92),
dispatches with undefined payloads (B-89), and inputs cleared by `document.querySelector` on every update (B-83).
PLAN.md prescribes Redux Toolkit/RTK Query.

## Decision

- One `baseApi` (`shared/api/baseApi.ts`, `createApi` with `tagTypes: ['Me', 'User', 'Friendships', 'Wall',
'Chat', 'Presence']`); features add endpoints with `injectEndpoints` in their own `<name>.api.ts`.
- Server state lives only in RTK Query caches, keyed by arguments (profile per id, wall per owner id).
- Lists with "load older" use `build.infiniteQuery` (RTK 2.14) with the cursor as `pageParam`.
- Socket events are applied in `onCacheEntryAdded` of the endpoint that owns the data, via `updateCachedData`, only
  after `cacheDataLoaded` (B-86). Friendship events invalidate `Friendships` and `User` tags (B-92, F-57).
- Mutations update the cache from the **server response** (no optimistic "accepted" without confirmation, B-26);
  buttons are disabled while `isLoading` (F-51, B-95); failures show an inline error and the state stays as it was
  (F-53).
- Plain slices only for: `realtime` connection status and nothing else; session expiry is an action handled by a
  listener middleware (`createListenerMiddleware`).
- **Session expiry is only for users who were logged in.** The base query dispatches `sessionExpired` on a 401
  only if the request is not `GET /me`, `/csrf-token` or `/auth/*` **and** `selectIsAuthenticated(state)` (the
  `getMe` cache holds a user) is true when the 401 arrives. A 401 on `PATCH /me` from a signed-in user is a real
  expiry. The `getMe` cache holds the `MeResponse` envelope `{ user }`, not the bare user, because RTK Query runs the
  endpoint's raw response schema on upserted values too: login/register write `{ user: res.user }` with
  `upsertQueryData`; `updateMe` and the avatar upload write their `MeResponse` as is. Socket signals
  (`disconnect` reason `io server disconnect`, `connect_error: unauthorized`) use the same guard. A 401 from
  `/api/me` means "visitor" and is handled silently by the loaders (ADR-0013), so a first-time visitor is never
  bounced from `/welcome` and never sees "Your session has expired".
- The listener resets the API state as its first step, so `selectIsAuthenticated` turns false and every later
  401 (in-flight requests, the welcome loader's own `getMe`) is a visitor 401: the message appears exactly once
  and no loop is possible.
- **No store ↔ router import cycle.** `store.ts` never imports the router. `main.tsx` calls
  `startSessionListener(store, router.navigate)` after creating both, so the listener receives navigation as a
  parameter; loaders import the store, nothing in the store imports the loaders. `import-x/no-cycle` enforces it.
- The CSRF token lives in memory (`shared/api/csrf.ts`) and is cleared on logout and in the session listener;
  the next mutation fetches a token bound to the new session, so logging in again without a reload works.
- `LogoutButton` disconnects its socket before posting logout, so the logging-out tab never sees a server-side
  disconnect and never shows the expiry message.
- Forms: react-hook-form 7.92 + `@hookform/resolvers` 7.0.6 with the shared Zod schemas; controlled inputs,
  defaults from current data (bio editor initialises from the cached bio, B-77). Drafts are cleared only after the
  owner's own successful submit (B-83, F-73, F-80).
- Avatar upload: custom `queryFn` using `XMLHttpRequest` for progress (F-35), with CSRF header, problem parsing
  (a non-JSON 413 maps to `file-too-large`) and `AbortController`-style cancel on dialog close. On success it
  updates `Me`, invalidates `User` self and the `Chat`, `Wall`, `Friendships`, `Presence` tags (F-37); URLs held
  elsewhere stay valid because avatar URLs are stable per user (ADR-0010).
- Function components and hooks only; `createRoot` (B-141).

## Alternatives

- **TanStack Query + Zustand**: equally good, but PLAN.md fixes Redux Toolkit; RTK Query is in the box.
- **Socket events into separate slices**: recreates B-86/B-91 (data outside the cache it belongs to).
- **Optimistic updates everywhere**: more code for rollback; responses here are fast and the legacy bug B-26 shows
  the risk of "success" without the server's answer. Chat uses a visible pending state instead.

## Consequences

- Every data view gets `isLoading / isError / isSuccess` branches for free and renders `LoadingState`,
  `ErrorState` (with "try again" → `refetch`) or `EmptyState` (F-25, F-105, B-82).
- Logging out or session expiry calls `baseApi.util.resetApiState()` and clears the CSRF token, so no previous
  user's data or token survives.
- `loaders.test.tsx` / `session-listener.test.ts` prove: a visitor stays on `/welcome` and `/welcome/about` with no
  `reason=expired`; a logged-in user whose next call returns 401 sees the message exactly once.
- Feature builders never write reducers for server data, which keeps parallel frontend work conflict-free (one
  `*.api.ts` per feature).
