# Features and Acceptance Criteria

This document lists every user-facing feature and behaviour of the legacy
**"Let's chat!"** social network (`_legacy/src/social-network`), rewritten as
numbered, testable acceptance criteria for the rebuild.

- Criteria without a marker describe behaviour that the legacy app already had
  (possibly in a broken form, see `BUGS.md`). The rebuild must implement it
  correctly.
- Criteria marked **(new)** are modern expectations that the legacy app did not
  meet. They are part of the definition of done unless they are listed under
  [Open decisions](#13-open-decisions-and-out-of-scope).
- "User" means an authenticated user, "visitor" means a person without a
  session.
- Every criterion should map to at least one automated test (unit, API
  integration or Playwright E2E). The suggested test level is given in
  brackets: `[unit]`, `[api]`, `[e2e]`, `[a11y]`.
- **Amendments.** This document was reconciled with the architecture in
  [ADR-0002](architecture/adr/0002-reconcile-features-with-house-standards.md):
  F-09 (password length), F-16 (throttling), F-68 (dropped), F-114 (health
  routes) and Appendices A and B (target paths and types) carry the decided
  values and name the ADR. For exact paths, payloads and column types,
  [API.md](architecture/API.md) and
  [DATA-MODEL.md](architecture/DATA-MODEL.md) are binding.
- **Label casing.** Quoted UI labels in this document ("Add friend",
  "Profile", "Friends", "Log out" …) give the wording, not the casing.
  Navigation items, buttons and form labels render in lowercase ("add
  friend", "profile"); content and messages use sentence case ("No friend
  requests right now."), per maw-design-system §1.7 and §10 (ADR-0002).
  E2E tests match role names case-insensitively. User names are never
  re-cased (F-58).

---

## 1. Pages and routing

| Path (rebuild)   | Legacy equivalent                      | Access        | Purpose                                     |
| ---------------- | -------------------------------------- | ------------- | ------------------------------------------- |
| `/welcome`       | `/welcome#/`                           | visitors only | Registration form + intro panel             |
| `/welcome/login` | `/welcome#/login`                      | visitors only | Login form                                  |
| `/welcome/about` | `/welcome#/about`                      | visitors only | About the project                           |
| `/`              | `/`                                    | users         | Own profile (avatar, name, bio, own wall)   |
| `/users/:id`     | `/users/:id`                           | users         | Another user's profile, friend button, wall |
| `/friends`       | `/friends`                             | users         | Friends, incoming and outgoing requests     |
| `/online`        | `/online`                              | users         | Users currently online                      |
| `/chat`          | `/chat`                                | users         | Global chat room                            |
| `*`              | (legacy served the SPA for everything) | all           | Not-found page **(new)**                    |

- **F-01** A visitor who requests any app page (`/`, `/users/:id`, `/friends`,
  `/online`, `/chat`) is redirected to `/welcome`. `[e2e]`
- **F-02** A user who requests any `/welcome…` page is redirected to `/`.
  `[e2e]`
- **F-03** The app uses one client-side router with real paths (no mix of hash
  and history routing). Navigating between app pages does not reload the page
  and does not reconnect the real-time socket. **(new)** `[e2e]`
- **F-04** An unknown path shows a "Page not found" view with a link back to
  the start page; unknown `/api/*` paths return HTTP 404 with a problem+json
  body (RFC 9457), never the HTML shell. **(new)** `[api][e2e]`
- **F-05** Every page sets a meaningful document title, e.g. `Chat · Let's chat!`.
  **(new)** `[e2e]`

## 2. Registration, login and logout (module `auth`)

### Registration

- **F-06** A visitor can register with first name, last name, email and
  password. On success the user is logged in immediately and lands on `/`.
  `[api][e2e]`
- **F-07** First and last name are required, trimmed, 1–100 characters. `[unit][api]`
- **F-08** Email is required, must be a syntactically valid address (no
  restriction on TLD length, `+` addressing allowed), is trimmed and stored
  lower-cased; uniqueness is case-insensitive. **(new: legacy regex rejected
  valid addresses and uniqueness was case-sensitive)** `[unit][api]`
- **F-09** Password is required, minimum 12 characters, maximum 256
  characters, no composition rules and no trimming; checked on the server and
  in the form by the same shared schema; the form hint says "At least 12
  characters." (legacy: 6 characters, client-side only). Test values: 11
  characters → 422, 12 and 256 accepted, 257 → 422. **(new; amended by
  ADR-0002 and [ADR-0006](architecture/adr/0006-password-policy-and-login-throttling.md):
  originally 8–128)** `[unit][api]`
- **F-10** Registering with an email that already exists fails with HTTP 409
  and the form shows "An account with this email already exists." next to the
  email field. **(new)** `[api][e2e]`
- **F-11** Validation errors are shown as text next to the related field (not
  only as a red outline), are announced to screen readers
  (`aria-describedby` + `aria-invalid`), and the submit button cannot send an
  invalid form. **(new)** `[e2e][a11y]`
- **F-12** The registration and login forms are real `<form>` elements:
  pressing Enter submits, every input has a visible `<label>`, correct `type`
  and `autocomplete` (`given-name`, `family-name`, `email`,
  `new-password`/`current-password`). **(new)** `[a11y][e2e]`
- **F-13** While a request is in flight the submit button is disabled and shows
  a busy state; double-clicking creates only one account. **(new)** `[e2e]`

### Login

- **F-14** A visitor can log in with email + password; on success they land on
  `/`. `[api][e2e]`
- **F-15** Wrong email or wrong password both return HTTP 401 with the same
  generic message "Email or password is incorrect." and take comparable time
  (no user enumeration). **(new)** `[api]`
- **F-16** Login attempts are rate-limited per IP and per email: register and
  login share 10 requests per 15 minutes per IP; failed logins are limited to
  5 per 15 minutes per email and IP and to 50 per hour per email from any IP.
  Exceeding a limit returns HTTP 429 with `Retry-After`. **(new; refined by
  ADR-0002 and ADR-0006: the IP in the strict per-email key prevents locking
  out the owner)** `[api]`
- **F-17** Passwords are stored as argon2id hashes; the hash is never returned
  by any endpoint or socket event. **(new)** `[api]`
- **F-18** The session ID is rotated on login and registration. **(new)** `[api]`

### Session and logout

- **F-19** The session cookie is `HttpOnly`, `SameSite=Lax`, `Secure` in
  production, signed with a secret from the environment, and expires after a
  configurable idle time (default 7 days). Sessions are stored server-side
  (Redis) so that logout invalidates them. **(new)** `[api]`
- **F-20** A user can log out from the header. Logout is a `POST` request
  protected by CSRF, destroys the server session, clears the cookie,
  disconnects the user's sockets and redirects to `/welcome/login`. **(new:
  legacy used `GET /logout`)** `[api][e2e]`
- **F-21** `GET /api/me` returns the current user's public profile
  (`id, firstName, lastName, bio, avatarUrl`) or HTTP 401. `[api]`
- **F-22** If the session expires while the app is open, the next API call
  returns 401 and the client redirects to `/welcome/login` with the message
  "Your session has expired. Please log in again." **(new)** `[e2e]`

### CSRF

- **F-23** Every state-changing HTTP request (`POST`, `PUT`, `PATCH`,
  `DELETE`) requires a valid CSRF token; requests without it return HTTP 403.
  `[api]`

## 3. Own profile and bio (module `profile`)

- **F-24** On `/` the user sees their avatar (or a default avatar), full name
  and bio. `[e2e]`
- **F-25** While the profile is loading, a skeleton/loading state is shown
  instead of a blank page. **(new)** `[e2e]`
- **F-26** If the user has no bio, the text "You have not written a bio yet."
  and an "Add bio" button are shown. `[e2e]`
- **F-27** Clicking "Add bio"/"Edit bio" shows a labelled textarea prefilled
  with the current bio and "Save" / "Cancel" buttons. `[e2e]`
- **F-28** Saving without changes keeps the bio unchanged (legacy wiped it).
  Saving an empty bio removes it only after an explicit change. `[e2e]`
- **F-29** The bio is trimmed and limited to 1 000 characters; a live counter
  shows the remaining characters; longer input is rejected by the server with
  HTTP 422. **(new)** `[unit][api][e2e]`
- **F-30** Cancel restores the previous bio and returns focus to the edit
  button. **(new)** `[e2e][a11y]`
- **F-31** A failed save keeps the editor open with the draft and shows an
  error message. **(new)** `[e2e]`
- **F-32** Bio text is rendered as plain text (line breaks preserved, no HTML).
  `[e2e]`

## 4. Avatar upload (module `upload`)

- **F-33** Clicking the avatar (header or profile) — which is a real
  `<button>` with an accessible name "Change profile picture" — opens the
  upload dialog. `[e2e][a11y]`
- **F-34** The dialog is an accessible modal (`<dialog>` or
  `role="dialog"` + `aria-modal`), traps focus, closes with Escape, a close
  button and a backdrop click, and returns focus to the trigger. **(new)**
  `[a11y][e2e]`
- **F-35** The user picks an image file; the dialog shows a preview, upload
  progress and a "Save" button. **(new: legacy uploaded immediately on
  `change`)** `[e2e]`
- **F-36** Upload rules (enforced on the server, mirrored on the client):
  see [Appendix C](#appendix-c-upload-rules). `[api]`
- **F-37** After a successful upload the new avatar appears immediately in
  the header, on the profile, and in every list/chat/wall entry rendered
  afterwards. `[e2e]`
- **F-38** An invalid file shows a specific message ("Please choose a JPEG,
  PNG, WebP or GIF image." / "The image must be 2 MB or smaller.") and does not
  close the dialog. **(new)** `[e2e]`
- **F-39** The previous avatar object is deleted from storage after the new
  one is saved. **(new)** `[api]`

## 5. Other user's profile

- **F-40** On `/users/:id` the user sees that user's avatar, name and bio
  ("No bio yet." if empty — legacy never showed other users' bios). `[e2e]`
- **F-41** Visiting `/users/<own id>` redirects to `/`. `[e2e]`
- **F-42** A non-existent or non-numeric id shows "This user does not exist."
  and neither a friend button nor a wall. The API returns 404. `[api][e2e]`
- **F-43** The profile endpoint only returns public fields
  (`id, firstName, lastName, bio, avatarUrl`); never email, password hash or
  timestamps of other users. **(new)** `[api]`
- **F-44** A loading state is shown while the profile loads. **(new)** `[e2e]`

## 6. Friendships (module `friends`)

Friendship state machine between the current user (me) and another user
(them):

| State            | Button label(s) on their profile      | Action                               |
| ---------------- | ------------------------------------- | ------------------------------------ |
| none             | "Add friend"                          | send request → `pending_outgoing`    |
| pending_outgoing | "Cancel request"                      | delete request → `none`              |
| pending_incoming | "Accept request", "Decline" **(new)** | accept → `friends`; decline → `none` |
| friends          | "Unfriend"                            | delete friendship → `none`           |

- **F-45** The friend button on another user's profile reflects the current
  state above. The server returns a **state enum**, not button text; labels
  live in the client. `[api][unit][e2e]`
- **F-46** A user can send a friend request to another existing user. Sending
  a request to oneself returns 422; to a non-existent user 404; when any
  friendship row between the two already exists (in either direction) 409.
  `[api]`
- **F-47** Only the sender can cancel a pending request. `[api]`
- **F-48** Only the receiver can accept a pending request. Accepting a request
  that does not exist returns 404 and the UI does not show "friends". `[api]`
- **F-49** The receiver can decline a pending request. **(new)** `[api][e2e]`
- **F-50** Either friend can end an accepted friendship; a confirmation is
  asked before unfriending. **(new: confirmation)** `[api][e2e]`
- **F-51** Concurrent or repeated clicks never create more than one
  friendship row per pair (database unique constraint on the unordered pair).
  The button is disabled while a request is in flight. `[api][e2e]`
- **F-52** When I receive a friend request, the friends navigation item shows
  an unread badge in real time. **(new)** `[e2e]`
- **F-53** A failed friendship action shows an error message and the button
  returns to its previous state. **(new)** `[e2e]`

## 7. Friends page

- **F-54** `/friends` shows three sections: "Friends", "Friend requests"
  (incoming) and "Sent requests" (outgoing, **new**). Each entry shows avatar
  and name and links to the user's profile (legacy entries were not links).
  `[e2e]`
- **F-55** Friends have an "Unfriend" action; incoming requests have "Accept"
  and "Decline"; sent requests have "Cancel". Actions update the lists without
  a reload; an accepted request moves from "Friend requests" to "Friends".
  `[e2e]`
- **F-56** Each empty section shows a helpful empty state (e.g. "No friend
  requests right now." / "You have not added any friends yet — try the
  search."). **(new)** `[e2e]`
- **F-57** The friends data is refetched when the page is opened and when a
  friendship event arrives, so the list is never stale. **(new)** `[e2e]`
- **F-58** Names are rendered in their stored case; any uppercase styling is
  done in CSS (`text-transform`) so screen readers read names normally.
  **(new)** `[a11y]`

## 8. User search

- **F-59** The header contains a labelled search field ("Find people").
  Typing at least 1 character (debounced ~300 ms) or pressing Enter shows
  matching users. **(new: legacy needed a click on "GO!")** `[e2e]`
- **F-60** Search matches the beginning of the first name, last name or full
  name, case-insensitively; `%` and `_` are treated as literal characters.
  `[api]`
- **F-61** Search returns **all** matches up to a limit (default 10, max 20),
  ordered by name, excluding the current user (legacy returned only the first
  match). `[api]`
- **F-62** Results are a listbox/combobox (WAI-ARIA pattern) navigable with
  arrow keys; each result links to `/users/:id`; Escape or clicking outside
  closes the results. **(new)** `[a11y][e2e]`
- **F-63** No match shows "No people found for "<query>"." (legacy crashed the
  app). `[e2e]`
- **F-64** Search runs over HTTP `GET /api/users/search?q=…` (cacheable,
  testable), not over the socket. **(new)** `[api]`

## 9. Wall posts (module `wall`)

- **F-65** Every profile has a wall. The owner and their accepted friends can
  read it; other users see "Become friends with <name> to see their wall."
  **(new: legacy showed every wall to every connected socket)** `[api][e2e]`
- **F-66** The owner can post on their own wall; accepted friends can post on
  the owner's wall. Anyone else gets HTTP 403 (enforced on the server; legacy
  only hid the textarea). `[api][e2e]`
- **F-67** A post contains text (1–2 000 characters after trimming); empty
  posts cannot be sent. `[unit][api]`
- **F-68** **Dropped for v1
  ([ADR-0011](architecture/adr/0011-scope-wall-visibility-and-v1-exclusions.md)).**
  Posts are text only: no image column, no image UI, no test. (Originally
  proposed as optional: one image per post following the upload rules; legacy
  had an unused `feed_imageurl` column.)
- **F-69** Each post shows the author's avatar and name (linked to their
  profile), the text, and a relative timestamp ("5 minutes ago") with the
  absolute date in a `<time datetime>` element. `[e2e]`
- **F-70** Posts are ordered newest first and paginated (cursor-based, 20 per
  page, "Load older posts" button or infinite scroll). **(new)** `[api][e2e]`
- **F-71** A post can be deleted by its author or by the wall owner — nobody
  else. The delete button is only shown to them; the server enforces it with 403. A confirmation is asked. `[api][e2e]`
- **F-72** New and deleted posts appear in real time only for viewers of that
  specific wall (socket room per wall). `[e2e]`
- **F-73** A user's unsent draft is never cleared by incoming posts from other
  users; the draft is cleared only after the own post was saved. `[e2e]`
- **F-74** Empty wall shows "No posts yet." plus, if the viewer may post,
  "Write the first one!". **(new)** `[e2e]`
- **F-75** Ctrl/Cmd+Enter submits; the textarea has a visible label
  ("Write on <name>'s wall"). **(new)** `[a11y][e2e]`

## 10. Global chat (module `chat`)

- **F-76** `/chat` shows the most recent 20 messages of the global chat room,
  oldest at the top, and an always-visible message input — also when there
  are no messages yet (legacy hid the input when the chat was empty). `[e2e]`
- **F-77** Each message shows author avatar, author name (linked to profile),
  text and timestamp. `[e2e]`
- **F-78** A user can send a message (1–1 000 characters after trimming) by
  pressing Enter or clicking "Send"; Shift+Enter inserts a line break. Empty
  messages cannot be sent. `[unit][e2e]`
- **F-79** A sent message appears for all connected users in real time with
  the server-assigned `id` and `createdAt`. The sender receives an
  acknowledgement; on failure the message is marked "Not sent — retry".
  `[e2e]`
- **F-80** Incoming messages do not clear the user's draft. `[e2e]`
- **F-81** The list auto-scrolls to new messages only when the user is already
  at the bottom; otherwise a "New messages" pill appears. **(new)** `[e2e]`
- **F-82** Scrolling to the top (or a "Load older messages" button) loads the
  previous page of messages (cursor pagination). **(new)** `[api][e2e]`
- **F-83** The message list is an `aria-live="polite"` log (`role="log"`).
  **(new)** `[a11y]`
- **F-84** Chat messages are rate-limited per user (e.g. 10 per 10 s).
  **(new)** `[api]`
- **F-85** Opening the chat or connecting a new client does not reset other
  users' chat views (legacy re-broadcast the last 10 messages to everyone on
  every connection). `[e2e]`

## 11. Presence / online users (module `presence`)

- **F-86** `/online` lists every other user who has at least one open
  connection, with avatar and name linking to their profile. `[e2e]`
- **F-87** A user who opens a second tab appears once; closing one of two tabs
  keeps them online; closing the last tab removes them from everyone's list
  in real time (with a short grace period, e.g. 5 s, to avoid flicker on
  reload). `[unit][e2e]`
- **F-88** Users who join appear in real time without duplicates. `[e2e]`
- **F-89** Empty state: "Nobody else is online right now." `[e2e]`
- **F-90** Presence events carry only public fields (`id, firstName,
lastName, avatarUrl`). `[api]`
- **F-91** Presence is stored in Redis (keyed by user id with a set of socket
  ids) so it works with multiple server instances and survives a restart.
  **(new)** `[unit]`

## 12. Layout, navigation, about page and cross-cutting quality

### Header and navigation

- **F-92** The header shows the logo (link to `/`), the search, the main
  navigation (Profile, Friends, Online, Chat), the user's avatar and a
  "Log out" button. `[e2e]`
- **F-93** The current page is marked with `aria-current="page"`. **(new)**
  `[a11y]`
- **F-94** On small screens (< 640 px) the navigation collapses into an
  accessible menu button (`aria-expanded`, `aria-controls`); the legacy
  "MENU" box did nothing. **(new)** `[e2e][a11y]`

### Welcome / about

- **F-95** The welcome area has a two-column layout on large screens (brand
  panel + form) and a single column on small screens. `[e2e]`
- **F-96** Login, registration and about are reachable from each other via
  visible links ("Already a member? Log in", "Not a member yet? Sign up",
  "About"). `[e2e]`
- **F-97** The about page describes the project and lists the technologies as
  plain text or real external links (legacy used dead `href="#"` links).
  `[e2e]`

### Responsiveness and design

- **F-98** All pages work from 320 px to 1 920 px width without horizontal
  scrolling or overlapping elements. **(new)** `[e2e]`
- **F-99** All colours, spacing, radii and typography come from the maw design
  tokens (accent rosé `#E59797`); no hard-coded values in component CSS.
  **(new)** `[lint]`

### Accessibility (WCAG 2.2 AA) **(new)**

- **F-100** axe reports no serious or critical violations on any page. `[a11y]`
- **F-101** All images have meaningful `alt` text (avatars: "<name>'s profile
  picture"; decorative images `alt=""`). `[a11y]`
- **F-102** Every interactive element is a native button/link, reachable by
  keyboard, with a visible `:focus-visible` indicator. `[a11y][e2e]`
- **F-103** The document has `lang="en"`, one `<h1>` per page, a logical
  heading order, landmarks (`header`, `nav`, `main`) and a skip link. `[a11y]`
- **F-104** Text meets 4.5:1 contrast; no font size below 12 px; motion
  respects `prefers-reduced-motion`. `[a11y]`

### Loading, error and empty states **(new)**

- **F-105** Every data view has explicit loading, error (with "Try again") and
  empty states; a blank screen is never shown. `[e2e]`
- **F-106** All API errors use RFC 9457 problem+json
  (`type, title, status, detail, errors[]`) with correct HTTP status codes
  (400/401/403/404/409/413/415/422/429/500); no stack traces in production.
  `[api]`
- **F-107** If the socket disconnects, a non-blocking banner "Reconnecting…"
  is shown and real-time features resume automatically after reconnect.
  `[e2e]`
- **F-108** Timestamps are stored as `timestamptz` and shown in the user's
  locale/timezone. `[unit]`

### Security and operations **(new)**

- **F-109** Security headers via helmet, including a strict CSP that allows
  images only from self and the configured storage origin. `[api]`
- **F-110** All configuration (ports, origins, DB URL, Redis URL, S3
  endpoint/bucket/public URL, session secret) comes from environment
  variables validated with Zod at start-up; the app refuses to start on
  invalid config. `[unit]`
- **F-111** Socket connections without a valid session are rejected during
  the handshake; socket origin is checked against the configured allow-list.
  `[api]`
- **F-112** Every socket event payload is validated with the same Zod schemas
  as the HTTP API; invalid payloads are rejected via acknowledgement error and
  never crash the server. `[unit][api]`
- **F-113** Structured logging (pino) without passwords, session contents,
  message text or other personal data; request ids are logged. `[unit]`
- **F-114** `GET /api/health` returns 200 when the DB and Redis are reachable
  and 503 otherwise. It is an alias of the readiness probe `GET /health/ready`;
  `GET /health/live` is the liveness probe (ADR-0002). **(new)** `[api]`
- **F-115** Seed script creates demo users, friendships, posts and chat
  messages for local development and E2E tests. **(new)**

---

## Appendix A: Data model

### Legacy schema (`social.sql`)

| Table               | Columns                                                                                                                                                                                                                           | Notes                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `social` (users)    | `id SERIAL PK`, `first VARCHAR(500) NOT NULL`, `last VARCHAR(500) NOT NULL`, `email VARCHAR(500) UNIQUE NOT NULL`, `password VARCHAR(500) NOT NULL`, `imageurl VARCHAR(500)`, `usersbio TEXT`, `created_at TIMESTAMP DEFAULT now` | email uniqueness case-sensitive                          |
| `friendships`       | `id SERIAL PK`, `sender_id INT NOT NULL → social(id)`, `receiver_id INT NOT NULL → social(id)`, `accepted BOOLEAN DEFAULT false`                                                                                                  | no unique pair, no self check, no indexes, no timestamps |
| `chat`              | `id SERIAL PK`, `sender_id INT NOT NULL → social(id)`, `chat_message TEXT NOT NULL`, `created_at TIMESTAMP`                                                                                                                       | single global room                                       |
| `feed` (wall posts) | `id SERIAL PK`, `sender_id INT NOT NULL → social(id)`, `receiver_id INT NOT NULL → social(id)`, `feed_text TEXT`, `feed_imageurl VARCHAR(500)`, `created_at TIMESTAMP`                                                            | `feed_imageurl` never written                            |

### Target schema (Drizzle migrations)

Amended by ADR-0002 and [ADR-0007](architecture/adr/0007-data-model-conventions.md):
`integer` identity keys instead of `bigint`, `text` email with a unique index
on `lower(email)` instead of `citext`, `timestamptz(3)`, and no wall image
column (F-68 dropped, ADR-0011). [DATA-MODEL.md](architecture/DATA-MODEL.md)
holds the exact Drizzle schema, CHECK constraints and index names.

| Table           | Columns and constraints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`         | `id integer identity PK`, `first_name text NOT NULL CHECK (length 1–100, trimmed)`, `last_name text NOT NULL CHECK (1–100, trimmed)`, `email text NOT NULL CHECK (stored lower-cased, length 3–254)` with `UNIQUE INDEX ON lower(email)`, `password_hash text NOT NULL`, `bio text NULL CHECK (length 1–1000)`, `avatar_key text NULL CHECK (server-generated key format)`, `created_at timestamptz(3) NOT NULL DEFAULT now()`, `updated_at timestamptz(3) NOT NULL DEFAULT now()`; prefix-search indexes on `lower(first_name)`, `lower(last_name)` and `lower(first_name \|\| ' ' \|\| last_name)` (`text_pattern_ops`) |
| `friendships`   | `id integer identity PK`, `requester_id integer → users ON DELETE CASCADE`, `addressee_id integer → users ON DELETE CASCADE`, `status friendship_status ('pending','accepted') NOT NULL DEFAULT 'pending'`, `created_at timestamptz(3) NOT NULL DEFAULT now()`, `accepted_at timestamptz(3) NULL`; `CHECK (requester_id <> addressee_id)`; `CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))`; `UNIQUE (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id))`; indexes on `(requester_id, status)`, `(addressee_id, status)`                                                                 |
| `chat_messages` | `id integer identity PK`, `author_id integer → users ON DELETE CASCADE`, `body text NOT NULL CHECK (length 1–1000, trimmed)`, `created_at timestamptz(3) NOT NULL DEFAULT now()`; indexes `(created_at DESC, id DESC)`, `author_id`                                                                                                                                                                                                                                                                                                                                                                                       |
| `wall_posts`    | `id integer identity PK`, `wall_owner_id integer → users ON DELETE CASCADE`, `author_id integer → users ON DELETE CASCADE`, `body text NOT NULL CHECK (length 1–2000, trimmed)`, `created_at timestamptz(3) NOT NULL DEFAULT now()`; indexes `(wall_owner_id, created_at DESC, id DESC)`, `author_id`; no image column (F-68 dropped)                                                                                                                                                                                                                                                                                     |
| sessions        | stored in Redis (`connect-redis`), not in Postgres                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Store object **keys**, not URLs. Avatars are served through the stable,
session-protected route `GET /api/users/:id/avatar`
([ADR-0010](architecture/adr/0010-avatar-upload-pipeline.md)), so the storage
host can change without a data migration.

## Appendix B: Endpoints and real-time events

### Legacy HTTP routes (`index.js`)

| Method + path                                                                                | Purpose                                 | Auth check in legacy |
| -------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------- |
| `POST /register`                                                                             | create user, log in                     | –                    |
| `POST /login`                                                                                | log in                                  | –                    |
| `GET /logout`                                                                                | clear session, redirect `/`             | –                    |
| `GET /users`                                                                                 | own full user row                       | none                 |
| `POST /usersbio`                                                                             | update own bio                          | none                 |
| `POST /upload`                                                                               | multipart `file` → S3 → set `imageurl`  | none                 |
| `GET /profile/:id`                                                                           | full user row of any user               | none                 |
| `GET /status/:otherProfileId`                                                                | friend button label                     | none                 |
| `POST /makeRequest/:id`, `/cancelRequest/:id`, `/acceptFriendship/:id`, `/endFriendship/:id` | friendship actions, return button label | none                 |
| `GET /friendsOrWanabees`                                                                     | friends + incoming requests             | none                 |
| `GET /welcome`, `GET *`                                                                      | serve SPA shell, redirect by session    | session check        |

### Legacy socket events

| Direction                          | Event                                  | Payload                                     |
| ---------------------------------- | -------------------------------------- | ------------------------------------------- |
| server → new socket                | `onlineUsers`                          | list of online users                        |
| server → others                    | `userJoined` / server → all `userLeft` | full user row                               |
| server → **all**                   | `showChat`                             | last 10 messages (sent on every connection) |
| client → server / server → all     | `newMessage`                           | text / message object                       |
| client → server / server → **all** | `allPosts`                             | profile id / all posts of that wall         |
| client → server / server → all     | `newPost`                              | `{profileId, message}` / post object        |
| client → server / server → all     | `deletePost`                           | post id                                     |
| client → server / server → caller  | `searchUser`                           | `{searchInput}` / first match               |

### Target HTTP API (JSON under `/api`, Zod contract in `packages/shared`)

Amended by ADR-0002: CSRF at `/api/csrf-token`, health probes at
`/health/live` and `/health/ready` plus `/api/health`, and the initial
presence list over HTTP instead of a socket event. Ids are positive
integers. [API.md](architecture/API.md) holds the request and response types,
status codes and limits.

| Method + path                          | Purpose                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /health/live`                     | liveness probe (outside `/api`)                                                    |
| `GET /health/ready`                    | readiness probe: DB and Redis reachable (outside `/api`)                           |
| `GET /api/health`                      | alias of `/health/ready` (F-114)                                                   |
| `GET /api/csrf-token`                  | issue CSRF token                                                                   |
| `POST /api/auth/register`              | register + start session (201)                                                     |
| `POST /api/auth/login`                 | log in (200 / 401 / 429)                                                           |
| `POST /api/auth/logout`                | log out (204)                                                                      |
| `GET /api/me`                          | current user                                                                       |
| `PATCH /api/me`                        | update bio                                                                         |
| `PUT /api/me/avatar`                   | upload avatar (multipart, field `avatar`)                                          |
| `GET /api/users/search?q=&limit=`      | search                                                                             |
| `GET /api/users/:id`                   | public profile + `relationship` (friendship state, `canViewWall`, `canPostOnWall`) |
| `GET /api/users/:id/avatar`            | the user's current avatar (`image/webp`)                                           |
| `GET /api/friendships`                 | `{ friends, incoming, outgoing }`                                                  |
| `POST /api/friendships` `{ userId }`   | send request                                                                       |
| `POST /api/friendships/:userId/accept` | accept                                                                             |
| `DELETE /api/friendships/:userId`      | cancel / decline / unfriend                                                        |
| `GET /api/users/:id/posts?cursor=`     | wall posts page                                                                    |
| `POST /api/users/:id/posts`            | create post                                                                        |
| `DELETE /api/posts/:id`                | delete post                                                                        |
| `GET /api/chat/messages?cursor=`       | chat history page                                                                  |
| `GET /api/presence`                    | online users (initial list; replaces the `presence:list` event)                    |

### Target socket events (socket.io 4 on `/socket.io`, WebSocket only, authenticated handshake)

| Direction                      | Event                                     | Payload / scope                                                    |
| ------------------------------ | ----------------------------------------- | ------------------------------------------------------------------ |
| server → others                | `presence:joined`                         | `UserSummary` (first connection only)                              |
| server → others                | `presence:left`                           | `{ userId }` (after the last connection and the grace period)      |
| client → server (ack)          | `chat:send`                               | `{ body }` → ack `{ ok: true, message }` or `{ ok: false, error }` |
| server → room `chat`           | `chat:message`                            | message with `id`, author, `createdAt`                             |
| client → server (ack)          | `wall:join` / `wall:leave`                | `{ userId }` (server checks read permission on join)               |
| server → room `wall:<id>`      | `wall:post-created` / `wall:post-deleted` | post / `{ id, wallOwnerId }`                                       |
| server → user room `user:<id>` | `friendship:changed`                      | `{ userId, state }` **(new)**                                      |

## Appendix C: Upload rules

| Rule                    | Value                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowed types           | JPEG, PNG, WebP, GIF — detected from magic bytes, not from the client MIME type or file extension                                                                          |
| Maximum size            | 2 MB (legacy limit), enforced while streaming (multer `limits.fileSize`) → 413                                                                                             |
| Files per request       | 1; other fields rejected                                                                                                                                                   |
| Processing **(new)**    | re-encode with `sharp` to WebP, max 512×512, strip EXIF/GPS metadata                                                                                                       |
| Object key              | server-generated (`avatars/<userId>/<uuid>.webp`); original filename ignored                                                                                               |
| Content-Type on storage | set from detected type, plus `Content-Disposition: inline` and `X-Content-Type-Options: nosniff` via the serving layer                                                     |
| Storage                 | S3-compatible (MinIO locally) via AWS SDK v3, private bucket; bucket and endpoint from env; served through `GET /api/users/:id/avatar`, not a public bucket URL (ADR-0010) |
| Temp files              | none on disk (memory/stream) or always cleaned up, also on error                                                                                                           |
| Errors                  | 400 no file, 413 too large, 415 wrong type, 500 storage failure — all problem+json                                                                                         |
| Auth                    | only the logged-in user, only for their own avatar, CSRF-protected                                                                                                         |

## 13. Open decisions and out of scope

All four decisions were settled in
[ADR-0011](architecture/adr/0011-scope-wall-visibility-and-v1-exclusions.md):

- Wall image posts (F-68): **dropped for v1**; there is no image column.
- Wall visibility (F-65): **friends-only** (owner and accepted friends read
  and write), not all logged-in users as in legacy.
- Private 1:1 messages: **out of scope for v1**. Only the global room exists;
  the README does not promise private chat.
- Password reset, email verification, account deletion, editing name/email:
  **out of scope for v1**. Foreign keys cascade on user deletion, so account
  deletion can be added later as one endpoint.
