# API and real-time contract

Every HTTP endpoint and socket event of `apps/api`. Request and response shapes are Zod schemas in
`packages/shared/src/*` (the single contract used by the API, the web app and the tests,
[ADR-0003](adr/0003-shared-zod-contracts-and-policies.md)). Response DTOs are built from `z.strictObject` at every
nesting level and asserted in integration tests (`expect(Schema.parse(res.body))`), so neither a top-level nor a
nested object (`author`, `user`, `items[]`) can silently grow private fields (B-19).

Conventions:

- JSON only, `/api` prefix (B-57). Health probes live at `/health/*` (plus `/api/health`, F-114).
- **Auth** column: `public` = no session needed; `user` = `requireAuth` (401 `unauthorized` otherwise).
- **CSRF**: every `POST`/`PUT`/`PATCH`/`DELETE` needs header `x-csrf-token` (403 otherwise, F-23).
  Token from `GET /api/csrf-token`, replaced by the token returned from register/login.
- Errors are RFC 9457 `application/problem+json` ([ADR-0004](adr/0004-error-model-problem-json.md)), F-106.
- Ids in paths: positive int32 written as plain decimal digits (`/^[1-9]\d{0,9}$/`). Anything else (`abc`, `0`,
  `1e3`, `0x1F`, ` 7`) is a 400 `invalid-request`; a well-formed id that does not exist is a 404 (the UI shows the
  same "This user does not exist." for both, F-42). Ids in JSON bodies and socket payloads must be JSON numbers
  (no coercion).
- Lists are newest-first cursor pages `{ items, nextCursor }` ([ADR-0014](adr/0014-cursor-pagination.md)).
- Timestamps are ISO 8601 UTC strings (`2026-11-15T14:05:00.000Z`).

## 1. Shared contract (`packages/shared/src`)

Written completely in the scaffold phase. File by file:

```ts
// ids.ts
// Bodies and socket payloads: a real JSON number, no coercion (true, [7], "7" are rejected).
export const Id = z.number().int().positive().max(2_147_483_647);
// Path params: decimal digits only, then the same range check ("1e3", "0x1F", " 7" are rejected).
export const IdParam = z
  .string()
  .regex(/^[1-9]\d{0,9}$/)
  .transform(Number)
  .pipe(Id);
export const IdParams = z.object({ id: IdParam });
export const UserIdParams = z.object({ userId: IdParam });
// Small query integers (page and search limits): digits only, no coercion of "1e1" or "".
export const intParam = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

// pagination.ts
export const PageQuery = z.object({
  limit: intParam(1, 50).default(20),
  cursor: z.string().min(1).max(200).optional(),
});
export const pageOf = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });

// problem.ts
export const ProblemCode = z.enum([
  'invalid-request',
  'validation-failed',
  'invalid-cursor',
  'unauthorized',
  'invalid-credentials',
  'csrf-invalid',
  'forbidden',
  'wall-forbidden',
  'wall-write-forbidden',
  'post-delete-forbidden',
  'not-found',
  'user-not-found',
  'post-not-found',
  'friend-request-not-found',
  'friendship-not-found',
  'email-taken',
  'friendship-exists',
  'cannot-befriend-self',
  'file-required',
  'file-too-large',
  'unsupported-media-type',
  'rate-limited',
  'internal',
]);
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  errors: z
    .array(z.object({ location: z.enum(['params', 'query', 'body', 'file']), path: z.string(), message: z.string() }))
    .optional(),
});
/** 'tag:arnoldovna.github.io,2026:social-network:problem:email-taken' -> 'email-taken'; 'about:blank' -> null */
export function problemCode(problem: Problem): ProblemCode | null;
// The API types AppError.code as ProblemCode, so it cannot throw a code outside this enum; a contract test covers
// the mapped third-party errors (multer, csrf-csrf, body-parser). See section 4.

// user.ts  (every response DTO is a z.strictObject; .extend() keeps strictness, proven by dto-strictness.test.ts)
export const UserSummary = z.strictObject({
  id: z.number().int().positive(),
  firstName: z.string(),
  lastName: z.string(),
  avatarUrl: z.string().nullable(), // '/api/users/12/avatar?v=<uuid>' or null (ADR-0010)
});
export const PublicUser = UserSummary.extend({ bio: z.string().nullable() });
export const Me = PublicUser; // F-21: no email, no timestamps
export const FirstName = z.string().trim().min(1, 'Please enter your first name.').max(100);
export const LastName = z.string().trim().min(1, 'Please enter your last name.').max(100);
export const Email = z.string().trim().toLowerCase().max(254).pipe(z.email('Please enter a valid email address.'));
export const Password = z.string().min(12, 'Use at least 12 characters.').max(256); // ADR-0006
export const Bio = z
  .string()
  .trim()
  .max(1000, 'Keep your bio under 1,000 characters.')
  .transform((v) => (v === '' ? null : v));
export const BIO_MAX = 1000;

// auth.ts
export const RegisterBody = z.object({ firstName: FirstName, lastName: LastName, email: Email, password: Password });
export const LoginBody = z.object({ email: Email, password: z.string().min(1).max(256) });
export const AuthResponse = z.strictObject({ user: Me, csrfToken: z.string() });
export const CsrfTokenResponse = z.strictObject({ token: z.string() });

// profile.ts
export const UpdateMeBody = z.object({ bio: Bio.nullable() });
export const MeResponse = z.strictObject({ user: Me });
export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  limit: intParam(1, 20).default(10),
});
export const SearchResponse = z.strictObject({ items: z.array(UserSummary) });

// friendships.ts
export const FriendshipState = z.enum(['none', 'pending_outgoing', 'pending_incoming', 'friends']);
export const RelationshipState = z.union([FriendshipState, z.literal('self')]);
export const UserProfileResponse = z.strictObject({
  user: PublicUser,
  relationship: z.strictObject({ state: RelationshipState, canViewWall: z.boolean(), canPostOnWall: z.boolean() }),
});
export const FriendEntry = z.strictObject({ user: UserSummary, since: z.iso.datetime() });
export const FriendshipsResponse = z.strictObject({
  friends: z.array(FriendEntry),
  incoming: z.array(FriendEntry),
  outgoing: z.array(FriendEntry),
});
export const SendFriendRequestBody = z.object({ userId: Id }); // JSON number only
export const FriendshipChange = z.strictObject({ userId: z.number().int().positive(), state: FriendshipState });

// wall.ts
export const WallPost = z.strictObject({
  id: z.number().int().positive(),
  wallOwnerId: z.number().int().positive(),
  author: UserSummary,
  body: z.string(),
  createdAt: z.iso.datetime(),
});
export const WallPage = pageOf(WallPost);
export const POST_MAX = 2000;
export const CreatePostBody = z.object({ body: z.string().trim().min(1, 'Write something first.').max(POST_MAX) });
export const CreatePostResponse = z.strictObject({ post: WallPost });

// chat.ts
export const ChatMessage = z.strictObject({
  id: z.number().int().positive(),
  author: UserSummary,
  body: z.string(),
  createdAt: z.iso.datetime(),
});
export const ChatPage = pageOf(ChatMessage);
export const CHAT_MAX = 1000;
export const SendChatMessage = z.object({ body: z.string().trim().min(1).max(CHAT_MAX) });

// presence.ts
export const PresenceResponse = z.strictObject({ items: z.array(UserSummary) });

// uploads.ts
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // Appendix C
export const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const AVATAR_FIELD = 'avatar';
export const AVATAR_MAX_SIDE_PX = 8192; // decompression-bomb guard (ADR-0010)
export const AVATAR_MAX_PIXELS = 25_000_000;

// policy.ts  (pure functions used by server AND client, so buttons and enforcement never disagree, B-90)
export const canDeleteWallPost = (viewerId: number, post: Pick<WallPost, 'wallOwnerId' | 'author'>) =>
  viewerId === post.author.id || viewerId === post.wallOwnerId;

// realtime.ts: see section 4
// index.ts: re-exports every file above
```

## 2. HTTP endpoints

### Infrastructure

| Method + path               | Auth   | Request | 2xx response                                                                                                                             | Errors                                                                     |
| --------------------------- | ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /health/live`          | public | –       | 200 `{ status: 'ok' }`                                                                                                                   | –                                                                          |
| `GET /health/ready`         | public | –       | 200 `{ status: 'ok' }`                                                                                                                   | 503 `{ status: 'unavailable' \| 'shutting-down' }` (no dependency details) |
| `GET /api/health` (F-114)   | public | –       | same handler as `/health/ready`                                                                                                          | same                                                                       |
| `GET /api/csrf-token`       | public | –       | 200 `CsrfTokenResponse`; binds an anonymous session first, with a 2 h `cookie.maxAge` (login/register regenerate it with the normal TTL) | 429                                                                        |
| any unknown `/api/*` (F-04) | –      | –       | –                                                                                                                                        | 404 `not-found` problem (never the HTML shell)                             |

Health routes are mounted before helmet, session and rate limits and are not logged.

`POST /__test/sign-in` exists only in apps built by `createTestApp()` (integration tests, ADR-0019 §3). The production
app never mounts it; an app without test routes answers it with the 404 `not-found` problem
(`test/app.int.test.ts`). CSRF protection runs before routing, so that 404 needs a valid `x-csrf-token`; without one
the same request is 403 `csrf-invalid`.

Rate limits are data, not code: `config/limits.ts` holds the production values (OVERVIEW §10), multiplied by
`RATE_LIMIT_MULTIPLIER` (default 1). The global limiter keys by `u:<userId>` when a session exists and by IP
otherwise, and skips `GET /api/users/:id/avatar` (session-protected, immutable-cached images).

### Auth (`features/auth`)

| Method + path             | Auth   | Request             | 2xx response                                                                                                                                                                   | Errors                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/auth/register` | public | body `RegisterBody` | 201 `AuthResponse`; session regenerated (F-18), new CSRF token                                                                                                                 | 400 malformed JSON · 403 `csrf-invalid` · 409 `email-taken` (`errors[0].path = 'email'`, F-10) · 422 `validation-failed` · 429 `rate-limited`                                                                                                                                                                      |
| `POST /api/auth/login`    | public | body `LoginBody`    | 200 `AuthResponse`; session regenerated, new CSRF token                                                                                                                        | 401 `invalid-credentials` "Email or password is incorrect." for unknown email **and** wrong password, dummy-hash verify for equal timing (F-15) · 403 · 422 · 429 with `Retry-After` (per IP 10/15 min on register+login; 5 failed/15 min per email **and** IP; 50 failed/h per email from any IP; F-16, ADR-0006) |
| `POST /api/auth/logout`   | user   | –                   | 204; session destroyed, cookie cleared, all sockets of this session disconnected (F-20). The SPA drops its in-memory CSRF token, because it was bound to the destroyed session | 401 · 403                                                                                                                                                                                                                                                                                                          |

### Profile and users (`features/users`)

| Method + path           | Auth | Request             | 2xx response                                                                                                                                                                                          | Errors                                          |
| ----------------------- | ---- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `GET /api/me`           | user | –                   | 200 `MeResponse` (F-21)                                                                                                                                                                               | 401                                             |
| `PATCH /api/me`         | user | body `UpdateMeBody` | 200 `MeResponse`                                                                                                                                                                                      | 401 · 403 · 422 (bio > 1000, F-29)              |
| `GET /api/users/search` | user | query `SearchQuery` | 200 `SearchResponse`: prefix match on first, last or full name, case-insensitive, `%`/`_` literal, current user excluded, ordered by name (F-59–F-64)                                                 | 400 `invalid-request` · 401 · 429 (60/min/user) |
| `GET /api/users/:id`    | user | params `IdParams`   | 200 `UserProfileResponse` (F-40, F-43, F-45). `relationship.state = 'self'` for the own id (client redirects to `/`, F-41). `canViewWall` = self or friends; `canPostOnWall` = same rule (F-65, F-66) | 400 · 401 · 404 `user-not-found` (F-42)         |

`/users/search` is registered before `/users/:id`.

### Avatar upload and media (`features/avatars`)

| Method + path               | Auth | Request                                                                    | 2xx response                                                                                                                                                                                                                                                                                        | Errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ---- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /api/me/avatar`        | user | `multipart/form-data`, exactly one file in field `avatar`, no other fields | 200 `MeResponse` with the new `avatarUrl` (F-37, B-62)                                                                                                                                                                                                                                              | 400 `file-required` (no file, B-33) / `invalid-request` (any other field or a second file: multer `fields: 0, parts: 1`) · 401 · 403 · 413 `file-too-large` (> 2 MB, multer `LIMIT_FILE_SIZE`, B-32; bodies > 3 MB are stopped by nginx, which answers the same problem+json) · 415 `unsupported-media-type` (magic bytes not JPEG/PNG/WebP/GIF, or undecodable image) · 422 `validation-failed` (`errors[0].location = 'file'`: more than 8192 px per side or 25 Mpx) · 429 (20/h/user) · 500 (storage failure; new object removed, DB unchanged) |
| `GET /api/users/:id/avatar` | user | params `IdParams`, query `v` optional (`^[0-9a-f-]{36}$`)                  | 200 `image/webp` stream of the user's **current** avatar, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `ETag` = current key's uuid. `Cache-Control: private, max-age=31536000, immutable` when `v` equals the current uuid, otherwise `private, no-cache` (revalidates to 304) | 400 · 401 · 404 (user has no avatar or object missing; never 500 for a missing key)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Pipeline: `requireAuth → uploadLimiter → avatarUpload(memory, 2 MB, files: 1, fields: 0, parts: 1) → controller`;
service sniffs, checks dimensions from the header (`metadata()`), re-encodes with `sharp` under a pixel limit
(rotate by EXIF, resize to fit 512×512, WebP q80, metadata stripped, first frame only), `put` new key →
`UPDATE users SET avatar_key = $new WHERE id = $me RETURNING OLD.avatar_key, NEW.<public cols>` (Postgres 18, one
atomic statement, correct under concurrent uploads) → `delete` old key (failure logged as warn, F-39). If the DB
update fails, the new object is deleted. Because `avatarUrl` points at the stable per-user route, every cached URL
keeps resolving after the old object is gone. See [ADR-0010](adr/0010-avatar-upload-pipeline.md).

### Friendships (`features/friends`)

| Method + path                          | Auth | Request                      | 2xx response                                                                                                                                                                                    | Errors                                                                                                                                                        |
| -------------------------------------- | ---- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/friendships`                 | user | –                            | 200 `FriendshipsResponse` (friends, incoming, outgoing; each ordered by name; F-54)                                                                                                             | 401                                                                                                                                                           |
| `POST /api/friendships`                | user | body `SendFriendRequestBody` | 201 `FriendshipChange` `{ userId, state: 'pending_outgoing' }`; emits `friendship:changed` to both users                                                                                        | 401 · 403 · 404 `user-not-found` · 409 `friendship-exists` (any row in either direction, F-46, F-51) · 422 `cannot-befriend-self` / `validation-failed` · 429 |
| `POST /api/friendships/:userId/accept` | user | params `UserIdParams`        | 200 `FriendshipChange` `{ state: 'friends' }`; only the addressee of a pending request (F-48)                                                                                                   | 400 · 401 · 403 · 404 `friend-request-not-found` (B-26) · 429                                                                                                 |
| `DELETE /api/friendships/:userId`      | user | params `UserIdParams`        | 200 `FriendshipChange` `{ state: 'none' }`; cancel (requester, F-47), decline (addressee, F-49) or unfriend (either, F-50). On unfriend, both users' sockets leave the other's `wall:<id>` room | 400 · 401 · 403 · 404 `friendship-not-found` · 429                                                                                                            |

Write limiter for all friendship and wall mutations: 60 per 10 min per user.

### Wall (`features/wall`)

| Method + path               | Auth | Request                                  | 2xx response                                                                                                             | Errors                                                                                                                              |
| --------------------------- | ---- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/users/:id/posts`  | user | params `IdParams`, query `PageQuery`     | 200 `WallPage` newest first (F-70)                                                                                       | 400 `invalid-request` / `invalid-cursor` · 401 · 403 `wall-forbidden` (not owner and not friend, F-65, B-23) · 404 `user-not-found` |
| `POST /api/users/:id/posts` | user | params `IdParams`, body `CreatePostBody` | 201 `CreatePostResponse` (inserted row joined with author, real post id, B-41); emits `wall:post-created` to `wall:<id>` | 401 · 403 `wall-write-forbidden` (F-66, B-22) · 404 · 422 · 429                                                                     |
| `DELETE /api/posts/:id`     | user | params `IdParams`                        | 204; emits `wall:post-deleted` to `wall:<ownerId>`                                                                       | 401 · 403 `post-delete-forbidden` (not author and not wall owner, F-71, B-21) · 404 `post-not-found`                                |

### Chat (`features/chat`)

| Method + path            | Auth | Request           | 2xx response                                                                                                                         | Errors    |
| ------------------------ | ---- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `GET /api/chat/messages` | user | query `PageQuery` | 200 `ChatPage` newest first; the client shows the reversed page (oldest at top, F-76) and loads older pages with `nextCursor` (F-82) | 400 · 401 |

Sending is a socket event (section 3), deliberately: one round trip with acknowledgement, protected by the
authenticated handshake and the origin allow-list instead of CSRF ([ADR-0005](adr/0005-sessions-csrf-and-socket-auth.md)).

### Presence (`features/presence`)

| Method + path       | Auth | Request | 2xx response                                                                                         | Errors |
| ------------------- | ---- | ------- | ---------------------------------------------------------------------------------------------------- | ------ |
| `GET /api/presence` | user | –       | 200 `PresenceResponse`: every other user with at least one open socket, ordered by name (F-86, F-90) | 401    |

This replaces the `presence:list` event proposed in FEATURES Appendix B: the initial list is cacheable,
testable over HTTP and refetched after a reconnect; sockets only carry deltas ([ADR-0002](adr/0002-reconcile-features-with-house-standards.md)).

## 3. Socket.io (path `/socket.io`, same origin)

### Handshake ([ADR-0005](adr/0005-sessions-csrf-and-socket-auth.md), F-111, B-38, B-07)

**WebSocket transport only** (`transports: ['websocket']` on server and client). Browsers always send `Origin` on a
WebSocket handshake, while they omit it on same-origin polling GETs; with polling disabled the origin rule can be
strict and exact.

1. `io.engine.use(sessionMiddleware)`: the same express-session middleware reads the cookie. engine.io 6.6 runs
   these middlewares **before** `allowRequest`, so a request with a validly signed session cookie costs one Redis
   read even when its origin is then refused (a request without such a cookie costs none; nothing connects either
   way).
2. `allowRequest`: the `Origin` header **must be present and** in `CORS_ORIGINS`. A missing or foreign origin is
   refused with 400 before the upgrade (CORS does not cover WebSockets). Integration tests send `Origin` explicitly
   through `extraHeaders` (Node clients send none) and assert that a missing and a foreign origin are both rejected.
3. `io.use` chain, each failing with `next(new Error(<code>))` → client `connect_error` with that `message`
   (`HandshakeErrorCode` in `realtime.ts`: `rate-limited`, `unauthorized`, `too-many-connections`, `internal` for an
   unexpected failure whose cause is logged, never sent):
   1. handshake limiter, 30 per minute per IP (Redis `ws-handshake`) → `rate-limited`;
   2. `authenticateSocket`: no `session.userId` → `unauthorized`; loads the `UserSummary` once into
      `socket.data.user`, stores `socket.data.sessionId`;
   3. per-user cap: 10 open sockets per user (size of `rooms.user(id)`) → `too-many-connections`.
4. On connection the server joins `rooms.user(id)`, `rooms.session(sid)` and `rooms.chat`, then calls each
   feature's registrar (presence first).

Server options: `transports: ['websocket']`, `maxHttpBufferSize: 16_384` (B-48), `pingInterval 25 s`,
`pingTimeout 20 s`, `connectionStateRecovery` off (resync over HTTP instead), `serveClient: false` (B-134).

Session lifetime is enforced on open sockets in two ways (`SessionGuard`):

- Per-event guard for mutating events (`chat:send`, `wall:join`): the session is re-read from Redis; if it is gone
  the ack is `unauthorized` and the socket is disconnected.
- Periodic sweep every 60 s: one pipelined `EXISTS` per distinct session id of the open sockets; sockets of a
  missing session are disconnected (`io.in(rooms.session(sid)).disconnectSockets(true)`), so expired or destroyed
  sessions stop receiving chat, wall and presence events and stop counting as online within a minute.

Client side: a `disconnect` with reason `io server disconnect` (server-side close, which socket.io-client never
retries) and a `connect_error` with `unauthorized` both dispatch `sessionExpired` when the client was
authenticated (ADR-0012). `rate-limited` and `too-many-connections` keep the "Reconnecting…" banner and retry
after 30 s.

### Payload validation (F-112, B-48)

Every client → server handler runs `Schema.safeParse(payload)` first and answers through the acknowledgement:

```ts
// realtime.ts
export const SocketErrorCode = z.enum([
  'validation-failed',
  'rate-limited',
  'unauthorized',
  'forbidden',
  'not-found',
  'internal',
]);
export const SocketError = z.object({
  code: SocketErrorCode,
  message: z.string(),
  retryAfterMs: z.number().int().optional(),
});
export type Ack<T extends object = object> = ({ ok: true } & T) | { ok: false; error: SocketError };
/** `connect_error` messages of a rejected handshake (section 3, Handshake). */
export const HandshakeErrorCode = z.enum(['rate-limited', 'unauthorized', 'too-many-connections', 'internal']);
```

A handler never throws to socket.io; unexpected errors are logged and acked as `internal`. A missing ack callback
(non-function) is ignored safely. Unknown events are dropped.

### Client → server

| Event        | Payload                                      | Ack                             | Rules                                                                                                                                                                      |
| ------------ | -------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat:send`  | `SendChatMessage` `{ body }`                 | `Ack<{ message: ChatMessage }>` | session alive; 10 per 10 s per user (F-84) → `rate-limited` + `retryAfterMs`; persisted with `insert … returning` + author join (B-47); then `chat:message` to room `chat` |
| `wall:join`  | `WallRoomPayload` `{ userId }` (JSON number) | `Ack`                           | `not-found` if the user does not exist, `forbidden` unless self or friends (B-39); joins `rooms.wall(userId)`; 30 per minute per user                                      |
| `wall:leave` | `WallRoomPayload`                            | `Ack`                           | always ok                                                                                                                                                                  |

### Server → client

| Event                | Payload                                                      | Room / target                                                                                                                                       | Emitted by                                        |
| -------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `chat:message`       | `ChatMessage`                                                | `chat` (every authenticated socket, including the sender; the client de-duplicates by `id`)                                                         | chat                                              |
| `wall:post-created`  | `WallPost`                                                   | `wall:<wallOwnerId>` only (F-72, B-40)                                                                                                              | wall service after `POST /api/users/:id/posts`    |
| `wall:post-deleted`  | `{ id: number, wallOwnerId: number }`                        | `wall:<wallOwnerId>`                                                                                                                                | wall service after `DELETE /api/posts/:id`        |
| `presence:joined`    | `UserSummary`                                                | everyone except the user's own sockets; only on the user's first connection, suppressed if the user reconnects within the grace period (F-87, F-88) | presence                                          |
| `presence:left`      | `{ userId: number }`                                         | everyone except the user's own sockets; only after the last socket closed and `PRESENCE_GRACE_MS` (5 s) passed without a reconnect (F-87, B-43)     | presence                                          |
| `friendship:changed` | `FriendshipChange` (state from the receiver's point of view) | `user:<requesterId>` and `user:<addresseeId>`                                                                                                       | friends service after every mutation (F-52, F-57) |

Typed maps shared by server (`Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>`) and client
(`Socket<ServerToClientEvents, ClientToServerEvents>`):

```ts
export interface ClientToServerEvents {
  'chat:send': (payload: unknown, ack: (res: Ack<{ message: ChatMessage }>) => void) => void;
  'wall:join': (payload: unknown, ack: (res: Ack) => void) => void;
  'wall:leave': (payload: unknown, ack: (res: Ack) => void) => void;
}
export interface ServerToClientEvents {
  'chat:message': (message: ChatMessage) => void;
  'wall:post-created': (post: WallPost) => void;
  'wall:post-deleted': (payload: { id: number; wallOwnerId: number }) => void;
  'presence:joined': (user: UserSummary) => void;
  'presence:left': (payload: { userId: number }) => void;
  'friendship:changed': (change: FriendshipChange) => void;
}
export const WallRoomPayload = z.object({ userId: Id });
```

Payload parameters are typed `unknown` on the server side on purpose: the type system forces the Zod parse.

## 4. Problem catalogue

| Status | Code(s)                                                                                             | When                                                                                                                                                                                                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid-request`                                                                                   | params or query fail Zod (`ValidationError` with status 400); any `MulterError` except `LIMIT_FILE_SIZE` (unexpected field, second file, extra part); malformed JSON (fixed detail "The request body is not valid JSON.", the body is never echoed, B-50) and other body-parser 4xx (status kept) |
| 400    | `invalid-cursor`                                                                                    | cursor not decodable                                                                                                                                                                                                                                                                              |
| 400    | `file-required`                                                                                     | upload without a file (`FileRequiredError`)                                                                                                                                                                                                                                                       |
| 401    | `unauthorized`                                                                                      | no session (`UnauthorizedError`; the template's `unauthenticated` is renamed)                                                                                                                                                                                                                     |
| 401    | `invalid-credentials`                                                                               | login failed                                                                                                                                                                                                                                                                                      |
| 403    | `csrf-invalid`                                                                                      | missing or wrong `x-csrf-token` (csrf-csrf `EBADCSRFTOKEN`, mapped in `toProblem`)                                                                                                                                                                                                                |
| 403    | `wall-forbidden`, `wall-write-forbidden`, `post-delete-forbidden`, `forbidden`                      | authorization in services                                                                                                                                                                                                                                                                         |
| 404    | `not-found`, `user-not-found`, `post-not-found`, `friend-request-not-found`, `friendship-not-found` | unknown route or resource                                                                                                                                                                                                                                                                         |
| 409    | `email-taken`, `friendship-exists`                                                                  | unique violations (Postgres `23505` mapped in the service, B-11)                                                                                                                                                                                                                                  |
| 413    | `file-too-large`                                                                                    | upload > 2 MB (multer `LIMIT_FILE_SIZE`); body > 3 MB (nginx `error_page 413`, same problem+json)                                                                                                                                                                                                 |
| 415    | `unsupported-media-type`                                                                            | sniffed type not allowed or undecodable                                                                                                                                                                                                                                                           |
| 422    | `validation-failed`, `cannot-befriend-self`                                                         | body fails Zod (`ValidationError` with status 422, `errors[]`); image dimensions too large (`location: 'file'`); semantic rule                                                                                                                                                                    |
| 429    | `rate-limited`                                                                                      | any limiter; `Retry-After` and `RateLimit` headers (draft-8)                                                                                                                                                                                                                                      |
| 500    | – (`about:blank`, "An unexpected error occurred.")                                                  | anything else; stack only in the log (F-106). `problemCode()` returns `null`; the client treats it as `internal`                                                                                                                                                                                  |

Every code thrown or mapped by the API is a member of `ProblemCode`: `AppError.code` is typed `ProblemCode`, and
`shared/errors/__tests__/problem-codes.test.ts` runs each third-party mapping (multer, csrf-csrf, body-parser,
rate limiter) through `toProblem` and parses the resulting code with `ProblemCode`.

`instance` is the request path without the query string (`/api/users/search`, never `?q=…`, F-113).

`TooManyRequestsError` (`shared/errors/app-error.ts`) is the one source of 429 `rate-limited`; every HTTP limiter
(`rateLimiter()` in `shared/security/security.ts`) forwards it to the error handler.

The web app's XHR upload client also maps a 413 response without a JSON body to `file-too-large`, so an
unexpected proxy page can never surface as a generic error.

Example:

```json
{
  "type": "tag:arnoldovna.github.io,2026:social-network:problem:validation-failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "The request body is invalid.",
  "instance": "/api/auth/register",
  "errors": [{ "location": "body", "path": "password", "message": "Use at least 12 characters." }]
}
```
