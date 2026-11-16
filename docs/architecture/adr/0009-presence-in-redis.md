# ADR-0009: Presence tracked in Redis per user with a socket set and a grace period

- Status: accepted (revised after the architecture critique: injectable key prefix)
- Date: 2026-11-15
- Related: B-43, B-44, B-45, B-46, B-75, B-87, F-86–F-91

## Context

Legacy presence was a module-level array (B-44) spliced with indexes from a different, de-duplicated snapshot
(B-43): wrong users disappeared, ghosts stayed online, `userLeft` fired while another tab was still open. It included
the current user (B-46), unauthenticated sockets, and full user rows with password hashes (B-19).

## Decision

- Redis keys (prefix `social-network:presence:`): `sockets:<userId>` = set of `<instanceId>:<socketId>`;
  `online` = set of user ids. `instanceId` is a UUID generated per process.
- On connect: `SADD sockets:<uid>`; if the set size became 1 and no leave timer is pending for the user →
  `SADD online` and emit `presence:joined` (UserSummary from the handshake) to everyone except `user:<uid>`.
  If a leave timer is pending (reload within the grace period) → cancel it and emit nothing.
- On disconnect: `SREM`; if the set is empty → start a `PRESENCE_GRACE_MS` (5 s) timer; when it fires, re-check
  `SCARD` and, if still 0, `SREM online` and emit `presence:left { userId }`.
- `GET /api/presence`: `SMEMBERS online` minus self → one `select … where id = any($ids)` → ordered by name.
  Only public fields (F-90). The client keeps a de-duplicated map keyed by id (B-87).
- Boot cleanup: in v1 (single instance) the instance deletes all `<keyPrefix>:presence:*` keys on start (SCAN +
  DEL), because every socket from before a restart is gone and clients reconnect on their own. Timers are
  in-process. `keyPrefix` is a module dependency (`APP_SLUG` in production, `test-<uuid>` per test app), so the
  boot cleanup of one integration test app can never wipe another's presence state.
- The service depends on a `PresenceStore` interface (Redis implementation + in-memory fake) and a clock/timer
  abstraction, so the grace logic is unit-tested with fake timers.

## Alternatives

- **In-memory Map**: correct for one process but lost on restart and wrong with more instances (F-91).
- **Redis key per user with TTL heartbeat**: robust across crashes, but needs periodic writes for every socket and
  delays "left" by the TTL.
- **socket.io `fetchSockets()` on each request**: needs the adapter for multi-instance and is O(sockets).

## Consequences

- Multi-instance needs a distributed grace timer (e.g. Redis keyspace expiry or a sorted set of pending leaves) and
  per-instance cleanup by `instanceId`; the key format already carries it.
- Presence does not hit Postgres on connect/disconnect (B-75); the handshake's single user lookup is reused.
