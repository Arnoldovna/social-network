/*
 * The CSRF token of the current session, in memory only (never localStorage or a readable cookie copy, OVERVIEW
 * §15). csrf-csrf binds it to the session id (ADR-0005), so it is:
 * - fetched lazily from `GET /api/csrf-token` before the first mutation (`ensureCsrfToken`),
 * - replaced by the token in the register/login response (`setCsrfToken`), because those regenerate the session,
 * - dropped on logout and on `sessionExpired` (`clearCsrfToken`), so the next mutation fetches one for the new session
 *   and logging in again without a reload works (ADR-0012).
 */

let token: string | null = null;
let pending: Promise<string> | null = null;
/** Bumped by every set/clear, so a fetch that started before the change cannot overwrite the newer state. */
let generation = 0;

export function getCsrfToken(): string | null {
  return token;
}

export function setCsrfToken(next: string): void {
  token = next;
  pending = null;
  generation += 1;
}

export function clearCsrfToken(): void {
  token = null;
  pending = null;
  generation += 1;
}

/**
 * The current token, loading it once with `load` when there is none. Concurrent callers share one request, so a burst
 * of mutations costs a single `GET /api/csrf-token`. A failed load leaves no token and rejects every waiting caller
 * with the loader's error; the next call tries again.
 *
 * A load that was overtaken while it ran (`setCsrfToken`/`clearCsrfToken` bumped the generation) never hands out its
 * own token, which belongs to the session that was current when the request left: the waiting callers get the newer
 * token from login/register, or, after a logout or expiry cleared it, a token loaded for the session that exists now.
 */
export function ensureCsrfToken(load: () => Promise<string>): Promise<string> {
  if (token !== null) {
    return Promise.resolve(token);
  }
  if (pending !== null) {
    return pending;
  }

  const startedAt = generation;
  const request = load()
    .then((fresh) => {
      if (generation === startedAt) {
        token = fresh;
        return fresh;
      }
      // Login/register stored a token while this one was loading: theirs belongs to the newer session. A logout or an
      // expiry cleared it instead: load one for the current session (joining a load that started since).
      return token ?? ensureCsrfToken(load);
    })
    .finally(() => {
      if (pending === request) {
        pending = null;
      }
    });
  pending = request;
  return request;
}
