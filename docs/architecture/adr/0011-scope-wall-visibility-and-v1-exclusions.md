# ADR-0011: Scope for v1: friends-only walls, no wall images, no private messages

- Status: accepted (resolves FEATURES §13 "Open decisions")
- Date: 2026-11-15
- Related: F-65, F-66, F-68, B-22, B-23, B-71, B-142

## Context

FEATURES.md leaves four decisions open: wall image posts (F-68), wall visibility (F-65), private 1:1 messages and
account management features (password reset, email verification, deletion, editing name/email).

## Decision

1. **Wall visibility: owner and accepted friends only** (read and write). Others see
   "Become friends with <name> to see their wall." The API returns `relationship.canViewWall/canPostOnWall` with the
   profile so the UI does not request posts it may not read; `GET /api/users/:id/posts` and `wall:join` enforce the
   rule with 403/`forbidden`.
2. **Wall image posts are dropped for v1.** No `image_key` column, no UI. Posts are text only (1–2000 characters).
   This resolves B-71 (rendering a broken `<img>` for every post) by construction.
3. **Private 1:1 messages: out of scope.** Only the global room exists (as in legacy). The README will not promise
   private chat (B-142).
4. **Password reset, email verification, account deletion, editing name/email: out of scope for v1.** The schema
   cascades on user deletion, so deletion can be added later as one endpoint.

## Alternatives

- **All logged-in users can read every wall** (legacy behaviour): simpler, but F-65 proposes friends-only and it
  gives the friendship feature a purpose.
- **Implement wall images** with the avatar pipeline: doable, but doubles upload surface and storage cleanup paths
  (post deletion must delete objects) for little portfolio value.
- **Private messages**: would need conversations, membership checks and unread state; a separate feature for later.

## Consequences

- Unfriending must also stop real-time wall updates for the former friend (sockets leave `wall:<id>`, ADR-0008).
- Posts written by a former friend stay on the owner's wall; the owner can delete them.
- F-68 is marked "dropped (ADR-0011)" in FEATURES.md and the traceability tables.
