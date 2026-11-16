# Legacy Bugs, Security Holes and Bad Practices

Adversarial review of the legacy project `_legacy/src/social-network`. Every
entry cites real code (`file:line`, paths relative to the legacy project
root). Each item must be resolved in the rebuild (definition of done:
"all BUGS solved"). Related acceptance criteria from `FEATURES.md` are
referenced as `→ F-xx`.

Severity: **Critical** (exploitable / data leak / data loss), **High**
(broken feature or serious risk), **Medium** (wrong behaviour, maintainability
risk), **Low** (cosmetic, hygiene).

Contents:
1. [Secrets and configuration](#1-secrets-and-configuration) B-01 – B-08
2. [Authentication and sessions](#2-authentication-and-sessions) B-09 – B-18
3. [Authorization and data exposure](#3-authorization-and-data-exposure) B-19 – B-28
4. [Uploads and storage](#4-uploads-and-storage) B-29 – B-37
5. [Real-time / socket.io](#5-real-time--socketio) B-38 – B-50
6. [HTTP API correctness and error handling](#6-http-api-correctness-and-error-handling) B-51 – B-62
7. [Database schema and queries](#7-database-schema-and-queries) B-63 – B-76
8. [Frontend logic and state](#8-frontend-logic-and-state) B-77 – B-101
9. [Accessibility](#9-accessibility) B-102 – B-112
10. [CSS](#10-css) B-113 – B-131
11. [Tooling, dependencies and repository hygiene](#11-tooling-dependencies-and-repository-hygiene) B-132 – B-142

---

## 1. Secrets and configuration

### B-01 Secrets committed to the repository — Critical
- **Location:** `secrets.json` (tracked by git), read in `db.js:9`, `s3.js:9`
- **Problem:** `secrets.json` with an AWS access key/secret and DB user/password is committed. The comment in `s3.js:9` claims "secrets.json is in .gitignore" — there is no `.gitignore` at all. (Values intentionally not repeated here; see `_legacy/SECRETS-REPORT.md`.)
- **Impact:** anyone with repo access gets AWS credentials (cost abuse, bucket takeover) and the DB password.
- **Fix:** rotate the keys (stage 0 of the plan); in the rebuild read all secrets from environment variables validated with Zod, ship only `.env.example`, ignore `.env*` in `.gitignore`, run gitleaks in lefthook pre-commit and CI. → F-110

### B-02 Hard-coded session secret — Critical
- **Location:** `index.js:36` (`secret: \`I'm always angry.\``)
- **Problem:** the cookie signing secret is a literal string in source.
- **Impact:** anyone who reads the code can forge a session cookie with any `userID` and log in as any user (cookie-session stores `userID` client-side, signed only by this secret).
- **Fix:** `SESSION_SECRET` from env (min. 32 random bytes, Zod-validated); server-side sessions in Redis so the cookie only contains an opaque id. → F-19

### B-03 Environment switch picks secrets file vs. env — Medium
- **Location:** `db.js:5-10`, `s3.js:5-10`
- **Problem:** `if NODE_ENV == "production" use process.env else require("./secrets.json")` is duplicated in two modules; missing values are silently `undefined`.
- **Impact:** app starts with broken config and fails later at runtime; duplicated logic.
- **Fix:** one `config` module that parses `process.env` with a Zod schema at start-up and exits with a clear message on invalid config. → F-110

### B-04 DB connection string built from credentials in code — Medium
- **Location:** `db.js:12-14`
- **Problem:** fallback URL is assembled from `secrets.dbUser`/`dbPassword` with host, port and DB name (`localhost:5432/social`) hard-coded.
- **Fix:** require `DATABASE_URL` from env; Docker Compose provides the local Postgres.

### B-05 Hard-coded S3 bucket and public URL — Medium
- **Location:** `s3.js:14` (`bucket: "spicedling"`), `config.json:2` (`s3Url`)
- **Problem:** a shared bootcamp bucket and its URL are baked into code and stored per user as full URL (`index.js:219`).
- **Fix:** `S3_BUCKET`, `S3_ENDPOINT`, `S3_PUBLIC_URL` from env; store only object keys in the DB, build URLs at read time. → Appendix A

### B-06 Hard-coded ports — Low
- **Location:** `index.js:267` (8080), `bundle-server.js:6` (8081), `index.js:58` (proxy target)
- **Fix:** `PORT` from env; Vite dev server proxy configured in `vite.config.ts`.

### B-07 Hard-coded socket.io origin — High
- **Location:** `index.js:13` (`origins: "localhost:8080"`)
- **Problem:** the only cross-site-websocket protection is a literal dev origin; in any deployed environment it either blocks the real origin or gets removed/widened.
- **Fix:** `CORS_ORIGINS` allow-list from env passed to socket.io `cors.origin`; plus session authentication on handshake. → F-111

### B-08 Static path relative to the working directory — Low
- **Location:** `index.js:65` (`express.static("./public")`)
- **Problem:** depends on the process cwd; started from another directory, no assets are served. (`sendFile` calls use `__dirname`, so behaviour is inconsistent.)
- **Fix:** resolve paths from the module location (`fileURLToPath(new URL(...))`); in production serve the built client from a known directory.

## 2. Authentication and sessions

### B-09 No server-side input validation on register — High
- **Location:** `index.js:67-87`, `db.js:68`
- **Problem:** body fields go straight into the DB; empty strings become `null` via `|| null` and only the `NOT NULL` constraint rejects them. No length limits (columns are `VARCHAR(500)`), no email format check, no password policy (the 6-char rule is client-only, `register.js:169`).
- **Impact:** 1-character passwords, junk emails, every failure collapses into `{ success: false }`.
- **Fix:** Zod schema in `packages/shared` used by client and server; 422 with field errors. → F-07–F-11

### B-10 Email uniqueness is case-sensitive — Medium
- **Location:** `social.sql:7`, `db.js:20`, `db.js:75`
- **Problem:** `Foo@x.com` and `foo@x.com` are different accounts; login requires the exact case used at registration.
- **Fix:** normalise (trim + lower-case) and use `citext` or a unique index on `lower(email)`. → F-08

### B-11 Duplicate email gives no useful message — Medium
- **Location:** `index.js:83-86`, `register.js:219`
- **Problem:** unique violation is caught, logged and answered with `{success:false}` (HTTP 200); the UI shows "ERROR TRY AGAIN!".
- **Fix:** map Postgres `23505` to 409 problem+json; show field message. → F-10

### B-12 Login relies on a TypeError for unknown emails — Medium
- **Location:** `db.js:18-24` (`result.rows[0].password`), `index.js:212-215`
- **Problem:** an unknown email throws `Cannot read property 'password' of undefined`, which is caught as "wrong login". Control flow by exception.
- **Fix:** repository returns `null` when not found; service handles it explicitly.

### B-13 User enumeration via timing — Medium
- **Location:** `index.js:194-216`
- **Problem:** for unknown emails no hash comparison happens, so the response is measurably faster than for existing emails.
- **Fix:** always run `argon2.verify` against a dummy hash when the user does not exist; identical 401 message. → F-15

### B-14 Redundant second query and un-returned promise in login — Medium
- **Location:** `index.js:195` + `index.js:202-206`
- **Problem:** the password and the id are fetched with two separate queries for the same row; the inner `db.getUserId(...).then(...)` is not returned, so its rejection is unhandled and the request never gets a response.
- **Fix:** one query `SELECT id, password_hash`; `async/await` with a central error handler.

### B-15 No brute-force protection — High
- **Location:** `index.js:194` (`/login`), `index.js:67` (`/register`)
- **Problem:** unlimited login and registration attempts.
- **Fix:** `express-rate-limit` with Redis store per IP and per email. → F-16

### B-16 Weak / outdated password hashing setup — Medium
- **Location:** `db.js:26-58`, `package.json:25` (`bcryptjs`)
- **Problem:** pure-JS bcrypt with default cost 10, hand-written promise wrappers around callback APIs; bcrypt silently truncates passwords > 72 bytes.
- **Fix:** argon2id (`argon2` package) with OWASP parameters, async API, max password length 128. → F-17

### B-17 Session cookie configuration — High
- **Location:** `index.js:35-38`
- **Problem:** cookie-session (client-side session) with 90-day lifetime, no `secure`, no `sameSite`, no rotation on login, no server-side invalidation — logout only clears the cookie in that browser; a stolen cookie is valid for 90 days. Session data is base64 and readable by the client.
- **Fix:** `express-session` + Redis store, `httpOnly`, `secure` (prod), `sameSite: 'lax'`, rolling 7-day idle timeout, `req.session.regenerate()` on login/register, `destroy()` on logout. → F-18, F-19

### B-18 Logout via GET — Medium
- **Location:** `index.js:244-248`, `app.js:173`
- **Problem:** a state-changing action on `GET` (logout CSRF: any `<img src="/logout">` logs the user out); logout redirects to `/` which then redirects again to `/welcome`.
- **Fix:** `POST /api/auth/logout` with CSRF, 204, client navigates to `/welcome/login`. → F-20

## 3. Authorization and data exposure

### B-19 Password hashes and emails leaked to the client — Critical
- **Location:** `db.js:81-85` (`SELECT * FROM social`), used by `index.js:102-113` (`GET /profile/:id`), `index.js:232-242` (`GET /users`), `index.js:342-345` (`userJoined`), `index.js:357-363` (`userLeft`)
- **Problem:** the full user row including `email` and bcrypt `password` hash is returned. `GET /profile/:id` returns **any** user's email and hash, and `userJoined`/`userLeft` broadcast them to **every connected socket**.
- **Impact:** mass harvesting of emails and offline cracking of password hashes.
- **Fix:** never `SELECT *`; explicit column lists / DTO mappers per use case (`PublicUser`, `Me`); response schemas validated in tests. → F-43, F-90

### B-20 No authentication on API routes — Critical
- **Location:** `index.js:89, 102, 115, 139, 149, 163, 175, 187, 218, 232`
- **Problem:** only the HTML catch-all (`index.js:259-265`) checks the session. All JSON routes run with `req.session.userID === undefined` for visitors; e.g. `GET /profile/:id` is fully public, `POST /upload` uploads to S3 before failing.
- **Fix:** `requireAuth` middleware mounted on every authenticated router; 401 problem+json. → F-01, F-21

### B-21 Anyone can delete any wall post — Critical
- **Location:** `index.js:433-445`, `db.js:255-261` (`DELETE FROM feed WHERE id = $1`), `wall.js:114-119`
- **Problem:** no ownership check at all — any socket (even unauthenticated) can emit `deletePost` with any id; the UI shows "DELETE POST" on every post to every viewer.
- **Fix:** `DELETE /api/posts/:id` allowed only for author or wall owner (`WHERE id = $1 AND (author_id = $2 OR wall_owner_id = $2)`), 403/404 otherwise; button only rendered when permitted. → F-71

### B-22 Anyone can post on any wall — High
- **Location:** `index.js:403-429`, `db.js:242-253`; client-only check in `wall.js:78-88`
- **Problem:** the "only own wall or friends" rule exists only in the UI. Any socket can emit `newPost` with any `profileId` (also non-existent ones → FK error swallowed).
- **Fix:** server checks "is owner or accepted friend" in the service layer; 403. → F-66

### B-23 Every wall is readable by anyone — High
- **Location:** `index.js:282-296`, `db.js:225-240`
- **Problem:** `allPosts` returns any profile's posts without checking login or friendship.
- **Fix:** read permission check (see F-65), 403 + "become friends" UI.

### B-24 Self-friendship and requests to non-existent users — Medium
- **Location:** `index.js:139-147`, `db.js:126-136`, `social.sql:18-23`
- **Problem:** `POST /makeRequest/<ownId>` creates a friendship with oneself; requesting a non-existent id raises an FK error that is never answered (request hangs).
- **Fix:** service validation (422 self, 404 unknown user) + `CHECK (requester_id <> addressee_id)`. → F-46

### B-25 Duplicate friendship rows / race condition — High
- **Location:** `db.js:126-136`, `social.sql:18-23`, `friendButton.js:35-40`
- **Problem:** no unique constraint on the user pair; double-clicking "Make Friend Request", or both users requesting each other, inserts several rows. `getStatus` (`db.js:111-124`) then returns an arbitrary `rows[0]` (no `ORDER BY`), so the button state flips randomly; `cancelRequest` deletes only one direction.
- **Fix:** unique index on `(LEAST(a,b), GREATEST(a,b))`, `INSERT … ON CONFLICT DO NOTHING` + 409, disabled button during requests. → F-51

### B-26 Accept succeeds in the UI even if nothing was accepted — Medium
- **Location:** `index.js:163-173`, `db.js:150-160`, `actions.js:13-19`
- **Problem:** the server always answers "End Friendship" even when the `UPDATE` matched zero rows; the redux action ignores the response and marks the entry as accepted.
- **Fix:** check affected rows → 404; client updates state from the server response (RTK Query invalidation). → F-48

### B-27 No way to decline a request — Medium
- **Location:** `friends.js:55-75`, `friendButton.js:50-59`
- **Problem:** incoming requests only offer "Accept"; the receiver cannot decline (the server's `endFriendship` would work, but no UI uses it for pending requests).
- **Fix:** "Decline" action → `DELETE /api/friendships/:userId`. → F-49

### B-28 CSRF does not cover socket events — High
- **Location:** `index.js:47-52` (csurf for HTTP only) vs. `index.js:373, 403, 433` (state-changing socket events)
- **Problem:** creating posts/messages and deleting posts happen over the socket, which carries the session cookie but no CSRF token; protection relies solely on the hard-coded origin (B-07).
- **Fix:** move mutations (posts, deletes) to CSRF-protected HTTP endpoints; for socket mutations (chat) enforce origin allow-list + authenticated handshake. → F-23, F-111

## 4. Uploads and storage

### B-29 No file type validation — Critical
- **Location:** `index.js:26-31` (no `fileFilter`), `uploader.js:47` (`accept="image/*"` is only a hint)
- **Problem:** any file type is accepted and stored.
- **Fix:** detect type from magic bytes (`file-type`), allow JPEG/PNG/WebP/GIF only, 415 otherwise. → Appendix C

### B-30 Stored XSS on the bucket via client-controlled extension and MIME type — Critical
- **Location:** `index.js:21` (`path.extname(file.originalname)`), `s3.js:22` (`"Content-Type": req.file.mimetype`), `s3.js:24` (`public-read`)
- **Problem:** an attacker uploads `x.html` with `Content-Type: text/html`; it is stored publicly readable with that type and extension on the bucket domain.
- **Impact:** hosting of phishing/XSS pages under a trusted domain.
- **Fix:** server-generated key and extension, content type from detected type, re-encode with sharp, `nosniff`. → Appendix C

### B-31 Upload directory does not exist — High
- **Location:** `index.js:16-18` (`__dirname + "/uploads"`)
- **Problem:** with a function `destination`, multer does not create the directory; `uploads/` is not in the repo, so a fresh clone fails every upload with `ENOENT`.
- **Fix:** stream uploads to memory (2 MB limit) and directly to S3/MinIO; no temp directory.

### B-32 Upload size error is unhandled — Medium
- **Location:** `index.js:28-30`, `index.js:218`
- **Problem:** a file > 2 MB makes multer call `next(err)`; there is no error middleware, so Express' default handler returns an HTML 500 page (with stack trace outside production). The client only logs (`uploader.js:28-30`).
- **Fix:** central error middleware mapping `LIMIT_FILE_SIZE` → 413 problem+json; message in the dialog. → F-38, F-106

### B-33 Missing-file case returns 500 — Low
- **Location:** `s3.js:18-20`, `uploader.js:15`
- **Problem:** "no file" is a client error but returns 500; cancelling the file picker sends `undefined` as file.
- **Fix:** 400 problem+json; client does not submit without a file.

### B-34 Unhandled stream errors crash the server — High
- **Location:** `s3.js:21-40`
- **Problem:** only `response` is handled; an `error` event on the S3 request (DNS/network failure) or on the read stream has no listener, which throws and crashes the Node process. Temp file is not removed on that path.
- **Fix:** AWS SDK v3 `Upload` with `await` inside try/catch; errors go to the error middleware.

### B-35 Dead/unsafe ordering in the upload handler — Medium
- **Location:** `index.js:218-230`
- **Problem:** `req.file.filename` is used on line 219 before the `if (req.file)` check on line 222 (dead check); `db.uploadImage` has no `.catch` — for a visitor `rows[0]` is undefined, the promise rejects and the request hangs while the file is already on S3.
- **Fix:** auth before upload, validation before storage, `async` handler with error middleware.

### B-36 Old avatars are never deleted — Low
- **Location:** `db.js:87-96`
- **Problem:** every upload leaves the previous object in the bucket forever.
- **Fix:** delete old key after successful DB update. → F-39

### B-37 Deprecated S3 client and public ACL — Medium
- **Location:** `s3.js:1` (`knox`), `s3.js:24`
- **Problem:** `knox` is unmaintained (AWS Signature v2); per-object `public-read` ACLs are disabled by default on new buckets.
- **Fix:** AWS SDK v3 (`@aws-sdk/client-s3`, `lib-storage`), bucket policy for the public prefix or signed URLs; MinIO locally.

## 5. Real-time / socket.io

### B-38 Unauthenticated sockets are accepted — Critical
- **Location:** `index.js:41-43`, `index.js:275-302`
- **Problem:** the handshake runs the session middleware but never rejects a missing `userID`; such sockets are pushed into `onlineUsers` with `userID: undefined` and can emit every event (see B-21, B-22).
- **Fix:** `io.use` middleware that rejects the connection without an authenticated session; `socket.data.userId` from the session. → F-111

### B-39 Opening a wall replaces every user's wall — Critical
- **Location:** `index.js:290` (`io.sockets.emit("allPosts", …)`)
- **Problem:** the posts of the requested profile are broadcast to **all** sockets; every connected user who is viewing any wall suddenly sees someone else's posts (and private walls leak, B-23).
- **Fix:** HTTP `GET /api/users/:id/posts`; real-time updates via a socket room per wall. → F-72

### B-40 New posts are broadcast to everyone — High
- **Location:** `index.js:423`, `reducer.js:85-91`
- **Problem:** `newPost` goes to all sockets and the reducer prepends it to whatever wall the receiver is currently viewing.
- **Fix:** emit to room `wall:<ownerId>` only. → F-72

### B-41 New post gets the user id as post id — Critical
- **Location:** `index.js:408-421` (`id: result.id` where `result` is the **sender's user row**)
- **Problem:** the real-time post object carries the author's user id instead of the post id. Clicking "DELETE POST" on a freshly added post emits `deletePost(<userId>)` and deletes an unrelated post whose id equals that user id. Duplicate React keys when a user posts twice.
- **Fix:** return the inserted row joined with author data (`INSERT … RETURNING` + join or a single CTE); shared Zod `WallPost` schema. → F-71

### B-42 Every new connection resets all chats — High
- **Location:** `index.js:448-456` (`io.sockets.emit("showChat", …)` on every connection)
- **Problem:** whenever anyone connects (including every full page navigation, B-79), all clients' chat lists are replaced by the last 10 messages; messages beyond those disappear from everyone's view.
- **Fix:** history via `GET /api/chat/messages` per client; socket only pushes new messages. → F-85

### B-43 Disconnect removes the wrong presence entry — High
- **Location:** `index.js:312-319`, `index.js:355-370`
- **Problem:** `IDs` is a de-duplicated snapshot taken at connection time (closure), but its index is used to `splice` the `onlineUsers` array (one entry per socket, different order). Wrong entries are removed, ghosts stay online forever, and `userLeft` is emitted even when the user still has another tab open (the `indexOfUserID > -1` check is always true).
- **Fix:** presence store keyed by user id with a set of socket ids (Redis); emit `left` only when the set becomes empty (after a grace period). → F-87

### B-44 In-memory presence state — Medium
- **Location:** `index.js:273`
- **Problem:** module-level array; lost on restart, wrong with more than one instance, grows with undefined users (B-38).
- **Fix:** Redis-backed presence + socket.io Redis adapter. → F-91

### B-45 Dead code in presence calculation — Low
- **Location:** `index.js:304-307` (`onlineUsers1` never used), `index.js:316-319` (O(n²) de-duplication)
- **Fix:** remove; use `Set`/`Map`.

### B-46 Online list contains the current user — Low
- **Location:** `index.js:324-331`, `onlineUsers.js:28`
- **Fix:** exclude self on the server. → F-86

### B-47 Chat message object lacks id and sender — High
- **Location:** `index.js:384-390`
- **Problem:** the broadcast message has no `id` (React key `undefined` → key warnings and wrong reconciliation in `chat.js:53`) and no `sender_id`; `created_at` is `new Date()` from the app server instead of the DB value.
- **Fix:** broadcast the persisted row (`RETURNING id, created_at`) mapped to the shared `ChatMessage` schema. → F-79

### B-48 No payload validation on socket events — High
- **Location:** `index.js:282, 373, 403, 433, 459`
- **Problem:** any type/size is accepted (objects, megabyte strings, `undefined`); empty messages fail at the DB `NOT NULL` and are silently swallowed — the sender gets no feedback.
- **Fix:** Zod validation + acknowledgements with error codes; `maxHttpBufferSize` limit; rate limiting. → F-78, F-84, F-112

### B-49 Search over the socket returns only one user and crashes the client — High
- **Location:** `index.js:459-465`, `db.js:263-277` (`return result.rows[0]`), `reducer.js:101-107` (`foundUsers: [action.userData]`), `search.js:50-59`
- **Problem:** only the first match is returned; with no match the reducer stores `[undefined]` and rendering `user.id` throws, unmounting the whole React app (blank page). No `.catch` on the server.
- **Fix:** `GET /api/users/search` returning a list with limit; empty-state UI. → F-59–F-64

### B-50 Excessive logging of personal data — Medium
- **Location:** `index.js:278` (whole session), `index.js:374` (chat text), `index.js:460, 462` (search), `db.js:105` (bio), `db.js:120, 133, 274`, `index.js:93`, `index.js:201`
- **Problem:** `console.log` of sessions, messages, bios and query results in production.
- **Fix:** pino with log levels and redaction; no message bodies or PII in logs. → F-113

## 6. HTTP API correctness and error handling

### B-51 Requests hang forever on errors — High
- **Location:** `index.js:115-137` (no catch), `index.js:139-147` (no catch, response only inside `if`), `index.js:149-161` (no response when `result` is falsy or on error), `index.js:163-173`, `index.js:175-185`, `index.js:187-192`, `index.js:232-242`
- **Problem:** many handlers either have no `.catch` or a `.catch` that only logs; the client waits until timeout, the button stays in the old state.
- **Fix:** Express 5 async handlers (rejected promises reach the error middleware automatically) + central RFC 9457 error middleware. → F-106

### B-52 `/makeRequest` works only because of two bugs — High
- **Location:** `index.js:143` (`req.session.userId` — wrong case, always `undefined`), `db.js:134` (returns `sender_id` number, so `result.sender_id` is `undefined`)
- **Problem:** `undefined == undefined` makes the condition true by accident. Fixing either bug alone breaks the feature.
- **Fix:** typed service returning the friendship state; TypeScript strict catches property typos.

### B-53 Server returns UI labels instead of state — Medium
- **Location:** `index.js:124-134, 144, 155, 168, 180`, `friendButton.js:35-70`
- **Problem:** the API answers `textInsideButton: "Cancel Friend Request"` and the client branches on string equality; any text change or translation breaks the logic.
- **Fix:** API returns `state: 'none' | 'pending_outgoing' | 'pending_incoming' | 'friends'`. → F-45

### B-54 Errors answered with HTTP 200 — Medium
- **Location:** `index.js:83-86, 96-99, 110-112, 207-215`
- **Problem:** failures return 200 with `{success:false}` or `{}`; clients cannot distinguish errors.
- **Fix:** proper status codes and problem+json. → F-106

### B-55 Missing user on `/profile/:id` handled by a client-side TypeError — Medium
- **Location:** `index.js:104-108` (returns `{ result: undefined }`), `otherProfile.js:25-38`
- **Problem:** "not found" is detected because `result.data.result.usersbio` throws inside `.then`; non-numeric ids cause a pg cast error answered with `{}`.
- **Fix:** validate `:id` as positive integer (400), 404 when missing. → F-42

### B-56 Bio update without auth/limits; wrong verb — Medium
- **Location:** `index.js:89-100`, `db.js:98-109`
- **Problem:** `POST /usersbio` without session check, no length limit on `TEXT`, logs the bio.
- **Fix:** `PATCH /api/me` with Zod (`bio ≤ 1000`). → F-29

### B-57 Catch-all returns the HTML shell for everything — Medium
- **Location:** `index.js:259-265`
- **Problem:** typos in API paths, `/favicon.ico` etc. get 200 + `index.html`; there is no 404 anywhere.
- **Fix:** API under `/api` with 404 handler; SPA fallback only for HTML navigation requests. → F-04

### B-58 CSRF token cookie on every response / deprecated `csurf` — Medium
- **Location:** `index.js:47-52`, `package.json:30`
- **Problem:** `csurf` is deprecated and unmaintained; a new token cookie is set on every request including static files (`mytoken`, no `SameSite`).
- **Fix:** maintained double-submit or synchroniser implementation (e.g. `csrf-csrf`), token endpoint `GET /api/csrf`. → F-23

### B-59 No security headers, no CSP — High
- **Location:** `index.js` (no helmet), `index.html`
- **Fix:** helmet with strict CSP, `X-Powered-By` off. → F-109

### B-60 Mixed promise styles, no async/await on the server — Low
- **Location:** `index.js` throughout, `db.js:26-58`
- **Problem:** nested `.then` chains, un-returned inner promises (B-14), manual promisification.
- **Fix:** `async/await` in controller → service → repository layers.

### B-61 Everything in one file — Medium
- **Location:** `index.js` (468 lines: config, middleware, routes, sockets), `db.js`
- **Fix:** feature modules `features/<name>/` (routes → controller → service → repository, schema, tests) as defined in PLAN.md.

### B-62 Unused upload result shape — Low
- **Location:** `index.js:223-226`, `db.js:87-96`
- **Problem:** handler returns `{ result: <url> }`; client uses `response.data.result` without validation.
- **Fix:** typed response `{ avatarUrl }` defined in shared schema.

## 7. Database schema and queries

### B-63 Schema script cannot be re-run — High
- **Location:** `social.sql:1` (`DROP TABLE IF EXISTS social;` first)
- **Problem:** `friendships`, `chat` and `feed` reference `social`; dropping `social` first fails with "cannot drop table social because other objects depend on it" once the tables exist.
- **Fix:** Drizzle migrations (versioned, forward-only) + seeds. → F-115

### B-64 Misleading table and column names — Low
- **Location:** `social.sql:3` (`social` = users), `social.sql:43` (`feed` = wall posts), `first`, `last`, `usersbio`, `imageurl`
- **Fix:** `users`, `wall_posts`, `chat_messages`, `first_name`, `bio`, `avatar_key`. → Appendix A

### B-65 Arbitrary `VARCHAR(500)` everywhere, no CHECK constraints — Medium
- **Location:** `social.sql:5-9, 48`
- **Fix:** `text` with CHECK length constraints matching the Zod schemas.

### B-66 Missing unique / CHECK constraints on friendships — High
- **Location:** `social.sql:18-23`
- **Fix:** see B-24, B-25; status enum instead of boolean, `created_at`, `accepted_at`.

### B-67 No foreign-key delete behaviour — Medium
- **Location:** `social.sql:20-21, 35, 45-46`
- **Problem:** deleting a user fails or leaves orphans.
- **Fix:** `ON DELETE CASCADE` where appropriate.

### B-68 No indexes on foreign keys or search columns — Medium
- **Location:** `social.sql` (only PKs and email unique)
- **Problem:** friendship lookups (`db.js:114-116`, `db.js:177-183`), wall queries (`db.js:228-233`) and the `ILIKE` search (`db.js:267-270`) scan whole tables.
- **Fix:** indexes listed in Appendix A.

### B-69 `TIMESTAMP` without time zone — Low
- **Location:** `social.sql:11, 37, 50`
- **Fix:** `timestamptz`. → F-108

### B-70 Empty wall posts allowed by the schema — Low
- **Location:** `social.sql:47-48` (`feed_text` and `feed_imageurl` both nullable)
- **Fix:** `body NOT NULL CHECK (length > 0)` (or CHECK that text or image exists).

### B-71 `feed_imageurl` is never written but always rendered — Medium
- **Location:** `db.js:242-253` (no image column in INSERT), `wall.js:111` (`<img src={post.feed_imageurl}>`)
- **Problem:** every post renders an `<img>` with `src={null}` → broken-image icon / empty element on every post.
- **Fix:** implement image posts or remove the column; only render an image when present. → F-68

### B-72 Sorting reversed in JavaScript instead of SQL — Low
- **Location:** `db.js:232` (`ORDER BY feed.id ASC`) + `index.js:290` (`.reverse()`), `db.js:217` + `index.js:451`
- **Fix:** `ORDER BY created_at DESC, id DESC` with cursor pagination.

### B-73 No pagination — Medium
- **Location:** `db.js:225-240` (all posts of a wall), `db.js:210-223` (hard-coded 10 messages, no older history)
- **Fix:** cursor pagination for posts and chat. → F-70, F-82

### B-74 Search: unescaped LIKE wildcards, dead `|| null`, no limit — Medium
- **Location:** `db.js:271` (`[input + "%" || null]`)
- **Problem:** `%`/`_` in user input act as wildcards; `input + "%"` is always truthy so `|| null` is dead; `undefined` input searches for `"undefined%"`; no `LIMIT`; full name ("Ada Lovelace") never matches.
- **Fix:** escape wildcards, trim, min length, limit, match full name. → F-60, F-61

### B-75 Extra round trips after inserts — Low
- **Location:** `index.js:375-380` (insert chat message, then `getDataById`), `index.js:404-409` (insert post, then `getDataById`), `index.js:342, 357` (DB query on every connect/disconnect just to build the event)
- **Fix:** single query with `RETURNING` + join/CTE; presence uses cached public user data.

### B-76 `|| null` coercion hides validation in the data layer — Low
- **Location:** `db.js:68, 117, 130, 142, 154, 166, 184, 205, 234, 250`
- **Problem:** `0`, `""` and `undefined` all become `NULL`; validation problems surface as constraint errors.
- **Fix:** validate in the schema layer; repositories take typed, already-valid input.

## 8. Frontend logic and state

### B-77 Bio is wiped when saving without changes — High
- **Location:** `bio.js:11` (`draftBio: ""`), `bio.js:53-57` (`defaultValue={this.props.usersbio}`), `bio.js:25-29`
- **Problem:** the textarea shows the old bio but `draftBio` stays `""` until the user types; clicking SAVE sends an empty string and deletes the bio.
- **Fix:** controlled form initialised from the current bio (react-hook-form + Zod). → F-28

### B-78 Other users' bios are never shown — High
- **Location:** `otherProfile.js:45` (`this.stateBio` instead of `this.state.otherBio`)
- **Problem:** typo; every other profile shows "No Bio Added".
- **Fix:** TypeScript strict + test. → F-40

### B-79 Navigation uses full page reloads — High
- **Location:** `app.js:76-90` (`<a href>`), `app.js:104-106` (navigation and search are outside `BrowserRouter`)
- **Problem:** every menu click reloads the app, opens a new socket (presence churn, B-42 chat reset for everyone), refetches everything.
- **Fix:** single router wrapping the whole layout; `NavLink`. → F-03

### B-80 Invalid `classname` prop — Low
- **Location:** `app.js:76, 80, 84, 88`
- **Problem:** lowercase `classname` is not applied (React warning); CSS rule `#menu-now .link` (`style.css:447`) never matches.
- **Fix:** typed JSX (TSX catches it).

### B-81 Typo in state key — Low
- **Location:** `app.js:18` (`uploaderIsVsible`) vs. `app.js:48, 55, 142` (`uploaderIsVisible`)
- **Fix:** typed state; remove dead key.

### B-82 Blank page while loading or on error — Medium
- **Location:** `app.js:33-42` (no catch), `app.js:66-68` (`return null`), `friends.js:27-29`, `onlineUsers.js:21-23`, `chat.js:42-44`
- **Problem:** no loading indicators; if `/users` fails or the session expired, `data.data.imageurl` throws and the app stays blank forever.
- **Fix:** RTK Query states (`isLoading`, `isError`) with skeleton/error components. → F-25, F-105

### B-83 Draft text is cleared by other users' activity — High
- **Location:** `chat.js:17-24`, `wall.js:43-49`, `search.js:17-22`
- **Problem:** `componentDidUpdate` clears `#textarea`/`.input` via `document.querySelector` on **every** update, including incoming messages/posts from others. The instance field `this.currentMessage` keeps the old text, so the next "SEND" re-sends the previous message while the visible field is empty.
- **Fix:** controlled inputs; clear only after a successful own submit (ack). → F-73, F-80

### B-84 First chat message can never be sent — High
- **Location:** `chat.js:80-81`
- **Problem:** when `allMessages` is empty, only "Start typing :)..." is rendered — without the textarea and send button.
- **Fix:** input is always rendered. → F-76

### B-85 Chat scroll handler can crash with an empty chat — Medium
- **Location:** `chat.js:20-21`
- **Problem:** `componentDidUpdate` accesses `this.chatContainer.scrollTop`, but the container is not rendered when the list is empty → TypeError on the next update. It also force-scrolls to the bottom even when the user scrolled up to read.
- **Fix:** scroll logic in an effect that checks the ref and the user's scroll position. → F-81

### B-86 Reducer crashes on events that arrive before initial data — Medium
- **Location:** `reducer.js:51` (`[...state.onlineUsers, …]`), `reducer.js:74`, `reducer.js:89` (`[...state.posts]`), `reducer.js:14` (`.map` on undefined)
- **Problem:** spreading `undefined` throws; e.g. a `newPost` broadcast (B-40) reaching a user who never opened a wall throws inside the socket handler and the update is lost.
- **Fix:** RTK slices with typed initial state; socket updates via `updateCachedData` only for loaded queries.

### B-87 Presence list duplicates — Low
- **Location:** `reducer.js:48-53`
- **Problem:** `USERJOINED` appends without de-duplication.
- **Fix:** entity adapter keyed by id. → F-88

### B-88 Literal semicolon rendered on the online page — Low
- **Location:** `onlineUsers.js:27` (`<h1>ONLINE USERS:</h1>;`)
- **Fix:** remove; covered by visual review.

### B-89 Pointless dispatches with undefined payloads — Low
- **Location:** `onlineUsers.js:12` (`dispatch(onlineUsers())`), `chat.js:14` (`dispatch(showChat())`)
- **Problem:** set the state to `undefined`; data actually arrives via the socket.
- **Fix:** remove; data fetching via RTK Query.

### B-90 Wall fetches friends instead of posts — Low
- **Location:** `wall.js:34`
- **Problem:** `!this.props.posts && dispatch(receiveFriendsAndWanabees())` — checks posts but loads friends (to decide whether the input is shown, client-side permission).
- **Fix:** the posts endpoint returns `canPost`/`canDelete` flags computed on the server.

### B-91 Global `posts` state shared by all walls — Medium
- **Location:** `reducer.js:78-99`
- **Problem:** a single `posts` array for whichever wall was opened last; navigating between profiles briefly shows the previous user's posts.
- **Fix:** cache per wall owner id (RTK Query arg). → F-72

### B-92 Friends list is fetched once and never refreshed — Medium
- **Location:** `friends.js:16-17`, `wall.js:34`
- **Problem:** new incoming requests only appear after a full reload; friend button state (component state) and friends page (redux) are two unsynchronised sources of truth.
- **Fix:** one RTK Query cache with tag invalidation + `friendship:changed` socket event. → F-57

### B-93 Friend and online entries are not links — Medium
- **Location:** `friends.js:8` (`Link` imported, unused), `friends.js:35-74`, `onlineUsers.js:28-38`, `search.js:50-61`
- **Problem:** you cannot open a friend's / online user's / search result's profile, although the README advertises it.
- **Fix:** each entry links to `/users/:id`. → F-54, F-62, F-86

### B-94 Search modal never closes, needs a click — Medium
- **Location:** `search.js:24-32` (only `click`), `search.js:47-63`
- **Fix:** combobox with Enter/Escape/outside-click. → F-59, F-62

### B-95 Friend button without loading/error states, double submits — Medium
- **Location:** `friendButton.js:14` (initial empty label renders an empty button), `friendButton.js:24-70` (no catch, never disabled)
- **Fix:** disabled while pending, error toast, rollback. → F-51, F-53

### B-96 Uploader dialog cannot be closed — Medium
- **Location:** `app.js:142-144`, `uploader.js:33-52`
- **Problem:** once opened, the only way out is uploading a file (or reloading).
- **Fix:** accessible dialog with close/Escape. → F-34

### B-97 Upload errors only in the console — Medium
- **Location:** `uploader.js:28-30`
- **Fix:** visible error message; progress state. → F-35, F-38

### B-98 Wall/FriendButton rendered for non-existent users — Low
- **Location:** `otherProfile.js:62, 65`
- **Problem:** the wall is rendered (and requests posts) even when `notFound` is true; the friend button is shown before the profile loaded.
- **Fix:** render only after successful load. → F-42

### B-99 Raw timestamps and missing author names — Medium
- **Location:** `chat.js:62`, `wall.js:113` (raw ISO strings), `chat.js:53-64`, `wall.js:105-112` (avatar only, no name)
- **Problem:** messages/posts cannot be attributed; dates unreadable.
- **Fix:** author name + `<time>` with `Intl.RelativeTimeFormat`. → F-69, F-77

### B-100 Confusing operator precedence in empty state — Low
- **Location:** `wall.js:129` (`{!posts || (!posts.length && <h1>No Posts!</h1>)}`)
- **Problem:** relies on React not rendering `true`; no loading state while `posts` is undefined.
- **Fix:** explicit `isLoading / isEmpty` branches. → F-74

### B-101 Odd constructs, dead code, circular imports — Low
- **Location:** `start.js:25` (comma operator to call `initSocket`), `friendButton.js:6-8` (stray block statement), `otherProfile.js:71-101` (unused `MyProfile`, commented-out render), `register.js:127-164` (commented-out validation), `register.js:22-24` (`exact="exact"` string), `about.js:9-25` (nested `HashRouter` with unreachable routes), `profile.js:3`, `bio.js:4`, `friendButton.js:3-4` (unused imports creating circular dependencies with `app.js`), `socket.js:15` (`initSocket(store)` called without `store` from `chat.js:27`, `wall.js:21`, `search.js:25`), `actions.js:8` / `reducer.js:4` (typo `RECEIVE_FRIENDS_AND_WANNANES`), `actions.js:86` (copy-pasted log text), `start.js:25` (German comment), `console.log` in nearly every file (e.g. `reducer.js:109` logs the whole state on every action, `search.js:79` on every store change)
- **Fix:** TypeScript strict, ESLint (`no-console`, `import/no-cycle`, `no-unused-vars`), Prettier; RTK action creators instead of string constants; English-only code.

## 9. Accessibility

### B-102 Images without `alt` — High
- **Location:** `app.js:156, 164`, `register.js:19, 74, 212`, `about.js:11, 16`, `otherProfile.js:57`, `friends.js:38, 40, 60, 62`, `onlineUsers.js:31, 33`, `chat.js:55, 57`, `wall.js:107, 109, 111`, `search.js:53, 55`
- **Fix:** meaningful or empty `alt`. → F-101

### B-103 Clickable image instead of a button — High
- **Location:** `app.js:156` (`<img onClick>`)
- **Problem:** not focusable, no keyboard activation, no accessible name.
- **Fix:** `<button>` with label "Change profile picture". → F-33

### B-104 No `<form>` elements, no labels — High
- **Location:** `register.js:83-99, 221-255`, `bio.js:53-57`, `chat.js:67-70`, `wall.js:91-95`, `search.js:39-43`
- **Problem:** placeholders as labels (disappear while typing, low contrast), Enter does not submit, no `autocomplete`, buttons without `type`.
- **Fix:** real forms with labels. → F-12, F-75

### B-105 Validation conveyed by colour only — High
- **Location:** `register.js:236, 244-246`, `style.css:186-193`
- **Problem:** invalid email/password only get a faint red outline; no text, no `aria-invalid`.
- **Fix:** text errors + ARIA. → F-11

### B-106 Focus indicator removed — High
- **Location:** `style.css:146` (`outline: none` on inputs); no `:focus` / `:focus-visible` styles anywhere
- **Fix:** visible `:focus-visible` ring from tokens. → F-102

### B-107 Missing document language, charset, viewport — Medium
- **Location:** `index.html:2-8`
- **Fix:** `lang="en"`, `<meta charset="utf-8">`, viewport meta. → F-103

### B-108 Heading and landmark structure — Medium
- **Location:** multiple `<h1>` (`uploader.js:36`, `otherProfile.js:52`, `friends.js:81`, `onlineUsers.js:27, 45`, `chat.js:80`, `wall.js:129`); section titles as `<p>` (`register.js:82, 220`, `friends.js:34, 56`); header is a `<div>` (`app.js:72`); nav is a `<div>` with `<br />` (`app.js:75-92`)
- **Fix:** semantic landmarks, one `h1` per page, skip link. → F-103

### B-109 Non-functional "MENU" control — Medium
- **Location:** `app.js:94`, `style.css:213-227`
- **Problem:** a `<p>` styled like a button with hover effect that does nothing.
- **Fix:** real disclosure button on small screens. → F-94

### B-110 Upper-casing names in JavaScript — Low
- **Location:** `friends.js:43, 65`, `onlineUsers.js:36`, `search.js:59`, `uploader.js:37`
- **Problem:** screen readers may spell out all-caps text; data mutated for presentation.
- **Fix:** `text-transform` in CSS if wanted. → F-58

### B-111 No live region for chat/wall updates — Medium
- **Location:** `chat.js:48-66`, `wall.js:101-124`
- **Fix:** `role="log"` / `aria-live`. → F-83

### B-112 Dead links — Low
- **Location:** `about.js:39-41` (`href="#"`)
- **Problem:** inside the `HashRouter` these "links" navigate to the sign-up view instead of anywhere useful.
- **Fix:** plain text or real external links. → F-97

## 10. CSS

### B-113 No design tokens, hard-coded colours repeated — Medium
- **Location:** `#0d02be` at `style.css:17, 173, 224, 381, 418`; `blue` at `444, 454, 464`; `#f1f1f1` at `238, 386`; `#e5f0fbb8` at `37`; `grey`, `black`, `white` throughout; `rgba(223, 80, 80, 0.37)` at `192`
- **Problem:** inconsistent hover colours (`#0d02be` vs. `blue`), no single source of truth.
- **Fix:** Tailwind 4 `@theme` maw tokens; Stylelint forbids hard-coded colours. → F-99

### B-114 Layout built from `position: fixed/absolute` + magic numbers — High
- **Location:** `style.css:10-29` (`32vw`, `7vw`, `18vh`, `62vw`, `27vh`), `41-101` (`3.45vh`, `7.5vw`, `16.5vw`, `29px`), `207-219` (`top: 57px; left: 95%`, `padding: 16px 119px`), `237-244` (`top: 200px; left: 21%`), `357-395` (`right: 442px`, `right: 318px`, `left: 499px`, `top: 95px`), `406-415` (`top: 132px`), `466-471`
- **Problem:** elements overlap or leave the viewport at other screen sizes; the wall's SEND button is pinned to the top-right of the page, far away from its textarea.
- **Fix:** flex/grid layout with spacing tokens, no positioning for layout. → F-98

### B-115 No responsive design — High
- **Location:** whole `style.css` (no media/container queries); fixed widths `379px` (`294`), `577px` (`320`), `754px` (`343`), `294px` (`387`)
- **Fix:** mobile-first layout, tested at 320/768/1280 px. → F-98

### B-116 ID selectors for styling — Medium
- **Location:** `style.css:41, 48, 55, 62, 70, 76, 84, 91, 96, 251, 319, 325, 406, 417, 447, 452, 457, 462, 466, 476`
- **Fix:** BEM classes only (PLAN.md CSS rules).

### B-117 Brittle structural selectors — Medium
- **Location:** `style.css:36` (`body > main > div > div > div > div > p > a`), `317-318` (empty rule), `481-483` (`body > main > div > div:nth-child(3) > div > div > button`)
- **Fix:** BEM classes on the elements.

### B-118 Duplicate and conflicting rules — Medium
- **Location:** `.blackBox input` at `145` and `154`; `.friendsImg` at `271` (`width: 20vw`) and `421` (`width: auto`); `.post-container .friend` at `300` and `347`; `#textarea` at `319` and `476`; `#menu-now a:hover` at `452` and `#menu-now > a:hover` at `462`; `.logout a` (`437`) vs. `#logout a` (`91`); `text-decoration: none` repeated ~12 times
- **Fix:** one component file per BEM block with `@apply`.

### B-119 Invalid CSS values — Low
- **Location:** `style.css:247` (`position: block`), `style.css:326` (`display: absolute`)
- **Fix:** Stylelint `declaration-property-value-no-unknown`.

### B-120 Dead CSS — Low
- **Location:** `#logout`, `#logoutImg` (`84-101`; markup uses `.logout`, image commented out), `.wall-container` (`220`), `.profileUser` (`246`), `#userdetail` (`251`), `.profileUserImg` (`257`), `.profile` (`261`; `ProfilePic` ignores `className`, `profile.js:19`), `.incorrectFirst/.incorrectLast` (`186-187`), `#menu-now .link` (`447`, see B-80)
- **Fix:** remove; PurgeCSS-like checks via Tailwind content scanning.

### B-121 Tiny font sizes — Medium
- **Location:** `style.css:32` (11px), `159` (10px, weight 100 placeholder), `339` and `354` (8px timestamps)
- **Fix:** type scale tokens, minimum 12 px (body 16 px). → F-104

### B-122 Hover changes font size (layout shift) — Low
- **Location:** `style.css:223-227`
- **Fix:** hover only changes colours from tokens.

### B-123 No focus / active / disabled styles — High
- **Location:** `.button` (`164-175`), `.search button` (`367-383`), `#feed .postInput > button` (`406-420`)
- **Fix:** state styles for hover, focus-visible, active, disabled. → F-102

### B-124 Universal selector for font — Low
- **Location:** `style.css:1-3` (`* { font-family: "Arial" }`, also repeated at `161`)
- **Problem:** no fallback stack, overrides inheritance on every element.
- **Fix:** font token on `body` (free OFL grotesk via `@fontsource`, fallback Arial/Helvetica per PLAN.md).

### B-125 Images sized with viewport units — Medium
- **Location:** `style.css:179` (`5vw` logo), `208` (`2vw` avatar ≈ 27 px on 1366 px, 6 px on mobile), `233` and `268` (`30vw`)
- **Fix:** fixed avatar size tokens with `aspect-ratio` and `object-fit: cover`.

### B-126 Horizontal overflow of friend lists — Medium
- **Location:** `style.css:275-292` (`.friends` flex row without wrap, items `30vw` each)
- **Fix:** responsive grid.

### B-127 Non-English / unclear class names — Low
- **Location:** `style.css:297` (`.abstand`), `121` (`.technologieContainer`), `.blackBox`, `.friend` used for posts (`wall.js:105`), `#feed` for walls
- **Fix:** English BEM names that describe the component.

### B-128 German comments in CSS — Low
- **Location:** `style.css:206, 229, 256`
- **Fix:** English only.

### B-129 Commented-out CSS left in — Low
- **Location:** `style.css:139, 201, 262, 306-308, 350, 426-435, 473-475`
- **Fix:** remove; history is in git.

### B-130 Search input/button with 30px font and absolute offsets — Low
- **Location:** `style.css:357-378`, `476-480`
- **Fix:** header layout with tokens.

### B-131 `overflow-y: scroll` always shows scrollbar — Low
- **Location:** `style.css:313`
- **Fix:** `overflow-y: auto`.

## 11. Tooling, dependencies and repository hygiene

### B-132 `node_modules` and `.DS_Store` committed — Medium
- **Location:** git index (8 489 files under `node_modules/`), `.DS_Store`
- **Fix:** `.gitignore` (node, OS, env, build output) from the first commit.

### B-133 End-of-life runtime and dependencies with known vulnerabilities — High
- **Location:** `package.json:12` (Node 8.11.3), `15` (axios 0.15.3), `43` (socket.io 2), `46` (webpack 1), babel 6 (`16-24`), `29` (`cookie-session` 2.0.0-alpha), `30` (`csurf`, deprecated), `33` (`knox`, unmaintained), `44` (`spiced-pg`, private bootcamp wrapper), React 16 / react-router 4 / redux 3
- **Fix:** current Node LTS (`.nvmrc`), pnpm, React 19, Vite, Redux Toolkit, Express 5, socket.io 4, Drizzle; Dependabot.

### B-134 Undeclared dependency and double-loaded socket client — Medium
- **Location:** `socket.js:1` imports `socket.io-client`, which is not in `package.json` (only present transitively); `index.html:15` additionally loads `/socket.io/socket.io.js` globally
- **Fix:** declare `socket.io-client` explicitly; load it only through the bundle.

### B-135 Build tools in production dependencies — Low
- **Location:** `package.json:14-47` (babel, webpack, dev middleware all in `dependencies`)
- **Fix:** `devDependencies`; multi-stage Docker build.

### B-136 Build output written into the project root — Low
- **Location:** `build.js:22-24` (`path: __dirname`, `bundle.js`), `index.js:62`
- **Fix:** Vite build to `dist/`, ignored by git.

### B-137 Whole `babel-polyfill` and Uglify — Low
- **Location:** `build.js:12-21`
- **Fix:** Vite with modern browserslist; no global polyfill.

### B-138 Dual-purpose build file — Low
- **Location:** `build.js:5, 44-60` (`require.main == module` switches between CLI build and dev middleware), `bundle-server.js`
- **Fix:** standard Vite dev server and build scripts.

### B-139 No tests, no lint, no type checking — High
- **Location:** `package.json:9` (`"test": "echo \"Error: no test specified\" && exit 1"`)
- **Fix:** `pnpm verify` (ESLint, Stylelint, utility-class check, typecheck, Vitest, Supertest + Testcontainers, Playwright + axe, gitleaks) in CI as defined in PLAN.md.

### B-140 Two routers with different strategies — Medium
- **Location:** `start.js:22-31` (decides by `location.pathname`), `register.js:20` (`HashRouter`), `about.js:9` (nested `HashRouter`), `app.js:106` (`BrowserRouter`)
- **Fix:** one React Router instance with nested routes and auth guards. → F-03

### B-141 Legacy React APIs — Low
- **Location:** `start.js:33` (`ReactDOM.render`), class components with string refs / DOM queries everywhere
- **Fix:** `createRoot`, function components and hooks.

### B-142 README is outdated and over-promises — Low
- **Location:** `README.md:2` (claims users can "visit friends' profiles" and "chat with" online users — neither is possible from the UI, see B-93), `README.md:5` (GIF hosted on an external service)
- **Fix:** new README per plan stage 3 (screenshots in repo, architecture diagram, setup, "what I learned").
