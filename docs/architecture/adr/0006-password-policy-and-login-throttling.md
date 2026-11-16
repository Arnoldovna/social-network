# ADR-0006: Password policy, hashing and login throttling

- Status: accepted (amends F-09 and refines F-16; revised after the architecture critique: per-email limiter keyed with the IP, limits as data)
- Date: 2026-11-15
- Related: B-09, B-12, B-13, B-14, B-15, B-16, F-09, F-15, F-16, F-17

## Context

Legacy: 6-character minimum checked only in the browser (B-09), bcryptjs with default cost and 72-byte truncation
(B-16), user enumeration by timing (B-13), control flow through a TypeError (B-12), two queries per login (B-14), no
brute-force protection (B-15). FEATURES F-09 proposes 8–128 characters; the house template uses 12–256.

## Decision

- Length **12–256**, no composition rules, no trimming of passwords, checked by the shared `Password` schema on both
  sides. The UI hint says "At least 12 characters." (NIST SP 800-63B favours length over composition.)
- argon2 0.45.2, argon2id, pinned `m=65536, t=3, p=4`; `needsRehash` on successful login stores an upgraded hash.
- Login: one query `select id, password_hash where lower(email) = $1`; when no row exists, verify against a
  precomputed dummy hash (created once in `container.ts`), then return the same 401 `invalid-credentials`
  "Email or password is incorrect." (F-15).
- Throttling (values from `config/limits.ts`, multiplied by `RATE_LIMIT_MULTIPLIER`, see below):
  - per IP: register + login share `authLimiter` 10 requests / 15 min (Redis store `auth`);
  - per account and source: 5 **failed** logins / 15 min keyed by `sha256(lower(email)) + ipKeyGenerator(ip, 56)`
    (the /56 prefix; a custom `keyGenerator` makes express-rate-limit ignore `ipv6Subnet`)
    (`skipSuccessfulRequests`), Redis store `login-email-ip`;
  - per account, any source: a looser ceiling of 50 **failed** logins / hour keyed by `sha256(lower(email))`,
    Redis store `login-email`, against distributed credential stuffing;
  - all answer 429 `rate-limited` with `Retry-After` and draft-8 `RateLimit` headers (F-16).
- Keying the strict limiter by email alone would itself be an account lockout: five wrong passwords from any IP
  would block the real owner, with the correct password, for as long as an attacker keeps it up. With the IP in
  the key, the owner on another network is unaffected; only the 50/h ceiling is shared, and keeping that up costs
  an attacker 50 attempts per hour per account.
- **Limits are data, not code.** `createApp` receives `deps.limits` (`resolveLimits(env)`: production defaults ×
  `RATE_LIMIT_MULTIPLIER`, default 1). Integration tests run with multiplier 100 (the shared `http.ts`
  `register()`/`login()` helpers would otherwise exhaust 10 / 15 min in one file); the dedicated limiter tests
  (`auth-limits.int.test.ts`, F-16 and B-15) build their own app with low explicit limits; the E2E stack sets
  multiplier 100 (all E2E traffic reaches the API from one IP, the Docker gateway, ADR-0016).

## Alternatives

- **8–128 as in F-09**: weaker than the house standard and inconsistent across Marina's projects.
- **bcrypt**: 72-byte limit and weaker memory hardness; argon2id is OWASP's first choice.
- **Account lockout**: lets attackers lock out real users. For the same reason the strict per-email window is
  keyed together with the IP.
- **One env variable per limit**: more configuration surface for no benefit; a single multiplier covers tests and
  E2E, and tests that need exact values pass a `limits` object directly.

## Consequences

- F-09 is amended to "12–256 characters" (test values updated accordingly).
- argon2 needs native prebuilds; the distroless image loads them (verified by the scaffold skill).
- Seed passwords come from `SEED_DEMO_PASSWORD`, which must also satisfy the 12-character minimum.
