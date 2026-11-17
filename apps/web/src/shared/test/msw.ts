import { PROBLEM_TYPE_PREFIX } from '@app/shared';
import type { Problem, ProblemCode } from '@app/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

import { clearCsrfToken } from '../api/csrf';

/**
 * The MSW server of the web component and unit tests (OVERVIEW §13): it starts with **no** handlers, every test adds
 * the ones it needs with `server.use(...)`, and any request without a handler fails the test. That keeps each test's
 * network explicit and makes a test that renders a sibling feature's real component fail loudly instead of hitting
 * a stub (BUILD-ORDER rule 7).
 *
 * Importing this module registers the lifecycle for the importing test file: listen before the first test, drop the
 * per-test handlers and the in-memory CSRF token after each test, close after the last. Do not call `listen()` again.
 *
 * msw 3 renamed v2's `onUnhandledRequest` to `onUnhandledFrame` (it also covers WebSocket frames); `'error'` is the
 * same strategy: an unhandled request rejects and logs which request had no handler.
 */
export const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});

afterEach(() => {
  server.resetHandlers();
  clearCsrfToken();
});

afterAll(() => {
  server.close();
});

/** The CSRF token `csrfTokenHandler()` answers with by default. */
export const TEST_CSRF_TOKEN = 'test-csrf-token';

/**
 * Absolute URL of an API path for handlers: `apiUrl('/me')` → `http://localhost:3000/api/me` (the test document's
 * origin, which is what the app's relative `/api/…` requests resolve against).
 */
export function apiUrl(path: string): string {
  return new URL(`/api${path.startsWith('/') ? path : `/${path}`}`, globalThis.location.href).href;
}

/**
 * An RFC 9457 response as the API sends it (ADR-0004): `problemResponse(409, 'email-taken', { detail: '…' })`.
 * `type` carries the code, so the client's `problemCode()` reads it exactly like a real answer.
 */
export function problemResponse(
  status: number,
  code: ProblemCode,
  overrides: Partial<Omit<Problem, 'type' | 'status'>> = {},
  init: { headers?: Record<string, string> } = {},
): HttpResponse<Problem> {
  const body: Problem = { type: `${PROBLEM_TYPE_PREFIX}${code}`, title: code, status, ...overrides };
  return HttpResponse.json(body, {
    status,
    headers: { 'content-type': 'application/problem+json', ...init.headers },
  });
}

/** `GET /api/csrf-token` answering `{ token }` (API.md §2), for tests that send mutations. */
export function csrfTokenHandler(token: string = TEST_CSRF_TOKEN) {
  return http.get(apiUrl('/csrf-token'), () => HttpResponse.json({ token }));
}

export { http, HttpResponse };
