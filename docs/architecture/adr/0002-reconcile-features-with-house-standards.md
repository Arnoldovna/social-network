# ADR-0002: Reconciling FEATURES.md with the house standards

- Status: accepted (FEATURES.md needs the amendments listed below)
- Date: 2026-11-15
- Related: FEATURES F-04, F-08, F-09, F-16, F-21, F-42, F-92, F-114, Appendix A/B; skills `express-feature-module`,
  `maw-design-system`

## Context

FEATURES.md was written from the legacy code before the house templates were final. In a few places it proposes
details that differ from the verified templates or from the maw design rules. Leaving both in place would make the
acceptance tests and the implementation disagree.

## Decision

| Topic                          | FEATURES.md says                            | Decision                                                                                                                                                                | Why                                                                                                                                                         |
| ------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password length (F-09)         | 8–128                                       | **12–256** (ADR-0006)                                                                                                                                                   | house standard in `express-feature-module`, consistent across all three rebuilt projects; still well within argon2 cost                                     |
| CSRF endpoint (Appendix B)     | `GET /api/csrf`                             | **`GET /api/csrf-token`**                                                                                                                                               | verified template path                                                                                                                                      |
| Health (F-114)                 | `GET /api/health`                           | **`/health/live`, `/health/ready`** (template) **plus `GET /api/health`** as an alias of readiness                                                                      | keeps the acceptance criterion and the compose/Playwright probes                                                                                            |
| Presence list (Appendix B)     | `presence:list` socket event on connect     | **`GET /api/presence`** + `presence:joined/left` deltas                                                                                                                 | initial state over HTTP is cacheable, testable and refetched after reconnect; avoids a second source of truth                                               |
| Email uniqueness (Appendix A)  | `citext`                                    | **unique index on `lower(email)`**, emails stored lower-cased (ADR-0007)                                                                                                | no extension needed, template-verified                                                                                                                      |
| Primary keys (Appendix A)      | `bigint identity`                           | **`integer identity`** (ADR-0007)                                                                                                                                       | template convention; JS numbers stay exact; int32 is ample                                                                                                  |
| Validation status              | F-29: 422; B-55: 400 for bad ids; F-42: 404 | **body → 422 `validation-failed`; params/query → 400 `invalid-request`; unknown id → 404** (ADR-0004). The UI shows "This user does not exist." for 400 and 404 alike   | consistent rule, satisfies F-29 and B-55; F-42's UI requirement holds                                                                                       |
| Login throttling (F-16)        | 5/15 min per IP and per email               | **per IP 10/15 min on register+login (template); 5 failed logins/15 min per email + IP; 50 failed logins/h per email from any IP** (ADR-0006)                           | keeps a strict per-email rule where credential stuffing matters without letting an attacker lock out the owner; the IP limit also covers shared NATs fairly |
| UI labels (F-45, F-92, F-54 …) | "Add friend", "Profile", "Friends" …        | **lowercase for navigation, buttons and labels** ("add friend", "profile"); sentence case for content and messages ("No friend requests right now.")                    | maw-design-system §1.7 and §10. E2E tests use case-insensitive role names                                                                                   |
| Wall images (F-68)             | optional                                    | **dropped for v1** (ADR-0011)                                                                                                                                           | resolves the open decision                                                                                                                                  |
| Upload limit (Appendix C)      | 2 MB                                        | **2 MB** (`UPLOAD_MAX_BYTES=2097152`; template default 5 MB is overridden)                                                                                              | FEATURES wins where it is stricter                                                                                                                          |
| Product name (F-05)            | "Let's chat!"                               | kept as the proper name in titles (`Chat · Let's chat!`); the wordmark renders "let's chat" in lowercase per the maw header pattern; no other exclamation marks in copy | proper noun vs. UI copy rule                                                                                                                                |

## Alternatives

- Follow FEATURES literally everywhere: would fork the verified templates (session, CSRF and health code) for this
  project only and weaken the password minimum.
- Follow the templates literally and drop FEATURES details: would lose the per-email throttle, `/api/health` and
  the 2 MB limit, which are stricter or explicitly requested.

## Consequences

- FEATURES.md must be amended in the Scaffold phase (F-09 text and test values, Appendix A/B paths and types,
  label casing note). The traceability in TRACEABILITY.md and the test mapping in OVERVIEW.md already use the
  decisions above.
- Acceptance tests encode the decided values; the architecture-critic should check this table first.
