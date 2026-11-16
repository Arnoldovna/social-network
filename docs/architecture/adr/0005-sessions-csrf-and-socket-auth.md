# ADR-0005: Redis sessions, csrf-csrf for HTTP, authenticated handshake for sockets

- Status: accepted (revised after the architecture critique: WebSocket-only transport with a strict Origin rule, sockets bounded by session lifetime)
- Date: 2026-11-15
- Related: B-02, B-07, B-17, B-18, B-20, B-28, B-38, B-58, F-18–F-23, F-111

## Context

The legacy app used cookie-session with a hard-coded secret (B-02: anyone can forge a session), a 90-day client-side
session without rotation or server-side invalidation (B-17), logout via GET (B-18), deprecated `csurf` (B-58), no
auth on JSON routes (B-20), and sockets that accepted everyone (B-38) while carrying all mutations without CSRF
protection (B-28), guarded only by a hard-coded origin (B-07).

## Decision

**HTTP**
- express-session 1.19 + connect-redis 10, the template's `createSessionMiddleware`: opaque id cookie
  (`__Host-social-network.sid` in production, `social-network.sid` on local http), `HttpOnly`, `SameSite=Lax`, `Secure` in production, `rolling`, idle TTL
  `SESSION_TTL_DAYS` (7), `saveUninitialized: false`. The session stores `userId` only.
- `establishSession` (regenerate → set → save) on register and login; `destroySession` + `clearCookie` on
  `POST /api/auth/logout` (CSRF-protected, 204).
- csrf-csrf 4.1 signed double submit, bound to the session id, header `x-csrf-token`, `GET /api/csrf-token` binds
  an anonymous session first (with a 2 h `cookie.maxAge`, so bots cannot park 7-day sessions in Redis);
  register/login return a fresh token. Token kept in memory in the SPA and dropped on logout and on session
  expiry, because it is bound to a session that no longer exists. Failures are 403 `csrf-invalid`.
- `requireAuth` on every router except register, login, csrf-token, health.

**Sockets**
- Same origin via nginx, **WebSocket transport only** (`transports: ['websocket']` on server and client).
  Browsers always send `Origin` on a WebSocket handshake but omit it on same-origin polling GETs, so only without
  polling can the rule be strict: `allowRequest` rejects a **missing** or non-allow-listed `Origin` (CORS does not
  protect WebSocket upgrades). Node test clients set `Origin` through `extraHeaders`; separate tests assert that a
  missing and a foreign origin are rejected.
- `io.engine.use(sessionMiddleware)` reuses the HTTP session; `io.use` applies a handshake limiter (30/min/IP),
  rejects handshakes without `userId` (`connect_error: unauthorized`), caps open sockets at 10 per user
  (`too-many-connections`) and loads the user summary once.
- Sockets join `rooms.session(sid)`; logout calls `publisher.disconnectSession(sid)` so the session's sockets close.
- Sockets are bounded by session lifetime: mutating events re-check that the session still exists in Redis, and a
  60 s sweep disconnects every socket whose session expired (TTL) or was destroyed (logout, re-login in another
  tab). The client turns the resulting `io server disconnect` (which socket.io-client never retries) into
  `sessionExpired` instead of showing "Reconnecting…" forever.
- Only `chat:send` mutates over the socket. Wall posts/deletes and friendship actions are HTTP with CSRF.
  For `chat:send` the protection is: authenticated handshake via a `SameSite=Lax` cookie (not sent on cross-site
  WebSocket requests from other sites' subresources), origin allow-list, session re-check, Zod, rate limit.

## Alternatives

- **JWT in localStorage**: XSS-exfiltratable, no server-side logout; rejected by PLAN.md (httpOnly sessions).
- **csrf-sync (synchroniser token)**: recommended by csrf-csrf's README for session apps, but PLAN.md chose
  csrf-csrf and binding it to the session id gives equivalent protection; switching needs its own ADR.
- **CSRF token in the socket handshake `auth` payload**: adds little over the origin check plus SameSite cookie and
  complicates reconnects (token rotation). Can be added later without protocol changes.
- **Allow a missing `Origin` and keep polling**: works for browsers (polling GETs are same-origin) but makes the
  origin rule weaker and depends on sticky sessions once a second instance exists. Rejected for the stricter
  WebSocket-only rule. The cost: networks that block WebSockets cannot connect; acceptable for this app.
- **All mutations over the socket** (legacy): no CSRF, no status codes, harder to test; rejected.

## Consequences

- Session secret and CSRF secret are required env values (≥ 32 chars); `.env.example` has them empty.
- Behind a proxy, `TRUST_PROXY` must be set or secure cookies are dropped (compose sets `1`).
- Logout affects only the current session's sockets; other devices stay logged in (acceptable for v1, matches HTTP
  semantics).
