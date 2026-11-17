import { PROBLEM_TYPE_PREFIX } from '@app/shared';
import { describe, expect, it, vi } from 'vitest';

import { getCsrfToken, setCsrfToken } from '../../api/csrf';
import { apiUrl, csrfTokenHandler, HttpResponse, http, problemResponse, server, TEST_CSRF_TOKEN } from '../msw';

// The order of these tests matters: the second and third prove what the first one leaves behind is gone.
describe('test MSW server', () => {
  it('answers with the handlers a test adds', async () => {
    server.use(http.get(apiUrl('/presence'), () => HttpResponse.json({ items: [] })));
    setCsrfToken('left-over-token');

    const response = await fetch(apiUrl('/presence'));

    await expect(response.json()).resolves.toEqual({ items: [] });
  });

  it('drops the previous test’s handlers, and an unhandled request fails instead of reaching the network', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(fetch(apiUrl('/presence'))).rejects.toThrow();

    consoleError.mockRestore();
  });

  it('clears the in-memory CSRF token between tests', () => {
    expect(getCsrfToken()).toBeNull();
  });

  it('resolves API paths against the test document’s origin', () => {
    expect(apiUrl('/me')).toBe(`${globalThis.location.origin}/api/me`);
    expect(apiUrl('users/7')).toBe(`${globalThis.location.origin}/api/users/7`);
  });

  it('builds problem+json responses the client can read', async () => {
    server.use(
      http.get(apiUrl('/users/9'), () =>
        problemResponse(
          404,
          'user-not-found',
          { detail: 'User was not found.' },
          { headers: { 'x-request-id': 'r1' } },
        ),
      ),
    );

    const response = await fetch(apiUrl('/users/9'));

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(response.headers.get('x-request-id')).toBe('r1');
    await expect(response.json()).resolves.toEqual({
      type: `${PROBLEM_TYPE_PREFIX}user-not-found`,
      title: 'user-not-found',
      status: 404,
      detail: 'User was not found.',
    });
  });

  it('serves a CSRF token', async () => {
    server.use(csrfTokenHandler());

    const response = await fetch(apiUrl('/csrf-token'));

    await expect(response.json()).resolves.toEqual({ token: TEST_CSRF_TOKEN });
  });
});
