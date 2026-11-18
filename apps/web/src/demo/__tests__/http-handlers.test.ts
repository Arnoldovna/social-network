import { AuthResponse, CsrfTokenResponse, MeResponse, Problem, problemCode, UserProfileResponse } from '@app/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { apiUrl, server } from '../../shared/test/msw';
import { createHttpHandlers } from '../http-handlers';
import { DEMO_PASSWORD } from '../state';
import { createTestBackend, MIRA_EMAIL } from './fakes';

const JSON_HEADERS = { 'content-type': 'application/json' };

async function problemOf(response: Response) {
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const problem = Problem.parse(await response.json());
  return { status: problem.status, code: problemCode(problem), problem };
}

describe('demo HTTP handlers (ADR-0020: the API contract answered in the browser)', () => {
  beforeEach(async () => {
    const { backend } = await createTestBackend();
    server.use(...createHttpHandlers(backend));
  });

  async function csrfToken(): Promise<string> {
    const response = await fetch(apiUrl('/csrf-token'));
    return CsrfTokenResponse.parse(await response.json()).token;
  }

  async function logIn(): Promise<string> {
    const response = await fetch(apiUrl('/auth/login'), {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-csrf-token': await csrfToken() },
      body: JSON.stringify({ email: MIRA_EMAIL, password: DEMO_PASSWORD }),
    });
    expect(response.status).toBe(200);
    return AuthResponse.parse(await response.json()).csrfToken;
  }

  it('answers a visitor’s GET /me with a 401 problem, as the loaders expect (ADR-0013)', async () => {
    const response = await fetch(apiUrl('/me'));

    expect(response.status).toBe(401);
    expect(await problemOf(response)).toMatchObject({ code: 'unauthorized', problem: { instance: '/api/me' } });
  });

  it('logs in with the CSRF token and then answers with the contract’s shapes', async () => {
    await logIn();

    const me = MeResponse.parse(await (await fetch(apiUrl('/me'))).json());
    const profile = UserProfileResponse.parse(await (await fetch(apiUrl('/users/2'))).json());

    expect(me.user.firstName).toBe('Mira');
    expect(profile.relationship).toEqual({ state: 'friends', canViewWall: true, canPostOnWall: true });
  });

  it('refuses a mutation without the CSRF token (403 csrf-invalid, F-23)', async () => {
    const response = await fetch(apiUrl('/auth/login'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: MIRA_EMAIL, password: DEMO_PASSWORD }),
    });

    expect(await problemOf(response)).toMatchObject({ status: 403, code: 'csrf-invalid' });
  });

  it('answers validation errors with 422 and field errors, malformed JSON with 400 (B-50)', async () => {
    const token = await csrfToken();
    const invalid = await fetch(apiUrl('/auth/register'), {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-csrf-token': token },
      body: JSON.stringify({ firstName: 'A', lastName: 'B', email: 'a@example.com', password: 'short' }),
    });
    const { status, code, problem } = await problemOf(invalid);
    expect([status, code]).toEqual([422, 'validation-failed']);
    expect(problem.errors).toEqual([{ location: 'body', path: 'password', message: 'Use at least 12 characters.' }]);

    const malformed = await fetch(apiUrl('/auth/login'), {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-csrf-token': token },
      body: '{"email":',
    });
    expect(await problemOf(malformed)).toMatchObject({ status: 400, code: 'invalid-request' });
  });

  it('routes /users/search before /users/:id and answers unknown /api paths with a 404 problem (F-04)', async () => {
    await logIn();

    const search = await fetch(apiUrl('/users/search?q=to'));
    expect(search.status).toBe(200);
    expect(((await search.json()) as { items: { firstName: string }[] }).items.map((user) => user.firstName)).toEqual([
      'Tomás',
    ]);

    const unknown = await fetch(apiUrl('/no-such-endpoint'));
    expect(await problemOf(unknown)).toMatchObject({ status: 404, code: 'not-found' });
  });

  it('answers an avatar upload that is not multipart with 400 invalid-request, like multer', async () => {
    const token = await logIn();

    const response = await fetch(apiUrl('/me/avatar'), {
      method: 'PUT',
      headers: { ...JSON_HEADERS, 'x-csrf-token': token },
      body: '{}',
    });

    expect(await problemOf(response)).toMatchObject({ status: 400, code: 'invalid-request' });
  });

  it('answers DELETE /posts/:id with 204 and an empty body', async () => {
    const token = await logIn();
    const created = await fetch(apiUrl('/users/1/posts'), {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-csrf-token': token },
      body: JSON.stringify({ body: 'Short-lived post' }),
    });
    expect(created.status).toBe(201);
    const { post } = (await created.json()) as { post: { id: number } };

    const deleted = await fetch(apiUrl(`/posts/${String(post.id)}`), {
      method: 'DELETE',
      headers: { 'x-csrf-token': token },
    });

    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
  });
});
