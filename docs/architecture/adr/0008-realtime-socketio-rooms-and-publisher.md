# ADR-0008: Real-time with socket.io rooms, HTTP mutations and a publisher port

- Status: accepted (revised after the architecture critique: canonical signatures from BUILD-ORDER, room helpers, WebSocket-only transport)
- Date: 2026-11-15
- Related: B-28, B-38–B-42, B-47, B-48, B-75, B-79, B-134, F-03, F-52, F-72, F-79, F-84, F-85, F-107, F-111, F-112

## Context

Legacy sockets broadcast everything to everyone: opening a wall replaced every user's wall (B-39), new posts went to
all sockets (B-40), every connection reset all chats (B-42), posts carried the user id as post id (B-41), chat
messages had no id (B-47), payloads were not validated (B-48) and mutations bypassed CSRF (B-28). Full page reloads
created a new socket on every navigation (B-79).

## Decision

- socket.io 4.8.4 server attached to the Express HTTP server, path `/socket.io`, `transports: ['websocket']`,
  `serveClient: false`, `maxHttpBufferSize: 16 KB`. Client `socket.io-client` 4.8.4 from the bundle with
  `transports: ['websocket']`, one socket per tab created after `getMe` succeeds and kept across client-side
  navigation. WebSocket-only makes the strict Origin rule possible (ADR-0005).
- Rooms: `user:<id>`, `session:<sid>`, `chat`, `wall:<ownerId>` (explicit `wall:join` with server-side
  permission check; `wall:leave` on unmount). Room names are built only by `shared/realtime/rooms.ts`
  (`rooms.user(id)`, `rooms.session(sid)`, `rooms.wall(ownerId)`, `rooms.chat`), so no feature hard-codes another
  feature's room format (friends calls `publisher.leaveRoom(rooms.user(a), rooms.wall(b))`).
- **History over HTTP, deltas over sockets.** Connecting emits nothing to other clients except presence deltas.
- **Mutations over HTTP**, except `chat:send` (ack-based, rate-limited). Event payloads are the persisted rows
  mapped to shared DTOs (`insert … returning` + author join), so ids and timestamps come from the DB.
- Every client event: session-alive guard → Zod parse → limiter → service → ack. Errors are acks, never throws.
- `shared/realtime/publisher.ts` defines `RealtimePublisher { emitToRoom, leaveRoom(roomOfSockets, room),
  disconnectSession }`. `container.ts` creates the `Server` (not yet attached) and the publisher around it; the
  services of auth, friends and wall receive the publisher; `server.ts` attaches the server to the HTTP server.
  Feature socket handlers are `SocketRegistrar = (socket: AppSocket, io: AppServer) => void` functions returned
  from each module's `index.ts` and registered in order (presence first) by `shared/realtime/socket-server.ts`.
  Chat broadcasts from its handler through that `io` and therefore takes no publisher. The module signatures in
  BUILD-ORDER 1b are canonical.
- Typed event maps in `packages/shared/src/realtime.ts` for both sides.
- Reconnect: the client shows "Reconnecting…" (F-107), and on `connect` after a disconnect it invalidates the
  real-time-backed caches and re-joins wall rooms.
- Sockets are bounded by session lifetime (per-event check plus a 60 s sweep, ADR-0005), capped at 10 per user,
  and handshakes are rate-limited per IP.
- **Single API instance in v1.** Presence and rate limits are in Redis already. For more instances: add
  `@socket.io/redis-adapter` (8.3.0 peers `socket.io-adapter ^2.5.4`; compatibility with node-redis 6 must be
  verified then). No sticky sessions are needed, because there is no polling transport. The per-user socket cap
  and the session sweep then need `fetchSockets()` across the adapter.

## Alternatives

- **Server-Sent Events + HTTP POST**: fine for one-way updates, but chat with acks and presence on disconnect are
  natural in socket.io, which PLAN.md prescribes.
- **Socket-only API** (legacy): no CSRF, no status codes, untestable with Supertest, no caching.
- **socket.io connection state recovery**: hides missed events only within a short window and needs the adapter to
  support it; an HTTP resync is simpler and always correct.

## Consequences

- Realtime-triggering services are unit-testable with a fake publisher; socket behaviour is covered by integration
  tests with `socket.io-client` against the real server on an ephemeral port.
- nginx needs a `/socket.io/` location with the WebSocket upgrade headers; CSP `connect-src 'self'` covers
  same-origin `ws:`/`wss:` in current browsers (proved by the E2E chat test in the Docker stack).
- Scaling out later is an adapter change, not an API change.
