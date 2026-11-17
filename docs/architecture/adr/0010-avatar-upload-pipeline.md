# ADR-0010: Avatar upload pipeline (memory → sniff → bounded sharp → private bucket → stable avatar route)

- Status: accepted (revised after the architecture critique: stable avatar URL, decompression-bomb limits,
  atomic key swap, no CDN mode in v1)
- Date: 2026-11-15
- Related: B-05, B-29–B-37, B-62, F-33–F-39, F-109, Appendix C

## Context

Legacy uploads accepted any file type (B-29), stored the client's extension and MIME type publicly on a shared
bucket (B-30, stored XSS), wrote to a non-existent temp directory (B-31), crashed the process on stream errors
(B-34), returned HTML 500 on oversize files (B-32), never deleted old avatars (B-36) and used the unmaintained `knox`
client with public ACLs (B-37).

The first draft of this ADR embedded the object key in every `avatarUrl` and deleted the old object right after an
upload. Every cached `UserSummary` (chat, walls, friendships, presence, search, `socket.data.user`, other clients)
then pointed at a 404, which breaks F-37. It also sent any sniffed image of ≤ 2 MB to sharp with the default pixel
limit (~268 Mpx), so a small PNG with huge dimensions could OOM-kill the single API process.

## Decision

1. `PUT /api/me/avatar`: `requireAuth` → CSRF (global) → `uploadLimiter` (20/h/user) → `avatarUpload` (multer
   `memoryStorage`, `limits { fileSize: 2 MB, files: 1, fields: 0, parts: 1 }`, field `avatar`). `LIMIT_FILE_SIZE`
   → 413 `file-too-large`; every other `MulterError` → 400 `invalid-request`; no file → 400 `file-required`
   (template deltas, BUILD-ORDER 1b).
2. `sniffImage` (`file-type` 22.3.0): JPEG, PNG, WebP, GIF only, else 415. Client filename and MIME are ignored.
3. **Bounded decoding** in `processAvatar` (`sharp` 0.35.5):
   - `sharp(buf).metadata()` reads only the header; width or height > 8192 px or width × height > 25 Mpx → 422
     `validation-failed` (`errors[0].location = 'file'`, "The image must be at most 8192 × 8192 pixels.").
   - Decode with `sharp(buf, { limitInputPixels: 25_000_000, failOn: 'error', pages: 1 })` (the limit also covers
     a header that lies), then `.rotate()` (EXIF orientation), resize `fit: 'cover'` to 512×512, WebP quality 80,
     metadata not kept (EXIF/GPS stripped), first frame only. Decoder errors → 415.
   - At start-up: `sharp.cache(false)`, `sharp.concurrency(1)`; a process-wide semaphore allows at most 2
     concurrent `processAvatar` calls.
   - The compose `api` service has `mem_limit: 768m`, so a mistake shows up as a failed request in tests, not as a
     host-wide OOM.
4. Key `avatars/<userId>/<uuid>.webp` (server-generated), `PutObject` with `ContentType: image/webp`.
5. **Atomic swap**: `UPDATE users SET avatar_key = $new WHERE id = $me RETURNING OLD.avatar_key AS old_key,
NEW.<public cols>` (Postgres 18 `OLD`/`NEW` in `RETURNING`, through drizzle's `sql`). Concurrent uploads by the
   same user serialise on the row lock, and each request gets exactly the key it replaced, so no object is
   orphaned and none is deleted twice. If the update fails, the new object is deleted.
6. Delete the old object after the DB update (warn on failure, never fail the request), F-39.
7. Response `{ user: Me }` with `avatarUrl` built by `avatarUrl(userId, key)`.
8. **Stable per-user URL**: `avatarUrl = /api/users/<id>/avatar?v=<uuid of the current key>` (or `null`). The
   route `GET /api/users/:id/avatar` (avatars module, `requireAuth`) looks up the user's current `avatar_key` (PK
   lookup), streams the object with `pipeline`, `Content-Type` from storage, `Content-Disposition: inline`,
   `nosniff` (helmet), `ETag` = the uuid. When `v` matches the current uuid: `Cache-Control: private,
max-age=31536000, immutable`; otherwise `private, no-cache` (revalidates to 304 cheaply). An old URL held in
   any cache therefore always resolves to an existing object; it can be stale at most, never broken.
9. **Freshness for the uploader (F-37)**: the web upload endpoint writes `Me`, invalidates `User` self and the
   `Chat`, `Wall`, `Friendships`, `Presence` tags, so everything rendered afterwards carries the new `v`. `<Avatar>`
   falls back to the initials field on `onError` as a last line of defence.
10. The global rate limiter skips the avatar route (it is session-protected and long-cached), so pages with many
    avatars never hit 429.
11. nginx answers request bodies over 3 MB itself with `error_page 413` → `application/problem+json`
    (`file-too-large`); the XHR client additionally maps any non-JSON 413 to `file-too-large`.
12. **No public-bucket / CDN mode in v1** (`MEDIA_PUBLIC_BASE_URL` removed): the SPA's CSP comes from a static
    `nginx.conf`, so a second image origin would violate `img-src`. If a CDN is added later, the nginx CSP is
    generated from an envsubst template (`/etc/nginx/templates`) and the avatar route redirects to it.

## Alternatives

- **Delayed deletion of the old object** (keep the key-based URL, sweep replaced keys after 24 h, broadcast a
  `user:updated` event so every client patches its caches): rejected. It needs a durable deletion queue (Redis has
  no persistence here, so it would be a new table), a sweeper with shutdown handling, a new socket event with
  cache patches in five endpoints, and a refresh of `socket.data.user`. The stable URL removes the failure mode
  with one PK lookup per image request instead. Other clients may show the previous picture until their next
  fetch, which is acceptable; nothing is ever broken.
- **Presigned PUT directly from the browser to S3**: skips server sniffing and re-encoding, so the server would have
  to post-process anyway; overkill for 2 MB avatars.
- **Public-read bucket + `S3_PUBLIC_URL`** (FEATURES Appendix C): needs bucket policies per environment and widens
  CSP; the media route keeps one origin and lets us require a session.
- **Keep the original format**: re-encoding removes polyglot payloads and metadata (GPS) and normalises size.
- **`with old as (select avatar_key …) update … returning old.avatar_key`** (first draft): races under concurrent
  uploads (both read the same old key); replaced by `RETURNING OLD`.

## Consequences

- Upload progress needs XHR on the client (ADR-0012).
- `sharp` adds a native dependency (prebuilt libvips for linux-x64 glibc, works in `node:26-slim` and distroless
  debian13); the scaffold phase verifies the Docker build with it.
- All avatars are square 512 px WebP, which simplifies CSS (`aspect-ratio: 1`, `object-fit: cover`).
- Each avatar image request costs one PK lookup; at portfolio scale this is negligible, and the immutable cache
  makes repeat views free.
- Integration tests generate fixture images with `sharp` at runtime (JPEG, PNG with EXIF, GIF, HTML disguised as
  `.png`, 3 MB file, **a tiny PNG whose IHDR declares 16000×16000 px**, built byte by byte with a valid CRC → 422
  without a memory spike) instead
  of committing binaries; a test proves an old `avatarUrl` still returns 200 after a new upload.
