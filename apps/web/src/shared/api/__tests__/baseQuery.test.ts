import { afterEach, describe, expect, it, vi } from 'vitest';

import { sessionExpired } from '../../session/session-events';
import { apiUrl, csrfTokenHandler, HttpResponse, http, problemResponse, server, TEST_CSRF_TOKEN } from '../../test/msw';
import { baseApi } from '../baseApi';
import { CSRF_HEADER } from '../baseQuery';
import { getCsrfToken, setCsrfToken } from '../csrf';
import { createTestStore, signInAs } from './fixtures';

/** Endpoints shaped like the features' ones, so the base query is exercised through RTK Query as in the app. */
const testApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    listFriendships: build.query<unknown, undefined>({ query: () => '/friendships' }),
    searchUsers: build.query<unknown, string>({ query: (q) => ({ url: '/users/search', params: { q } }) }),
    sendFriendRequest: build.mutation<unknown, { userId: number }>({
      query: (body) => ({ url: '/friendships', method: 'POST', body }),
    }),
    deletePost: build.mutation<unknown, number>({
      query: (id) => ({ url: `/posts/${String(id)}`, method: 'DELETE', headers: [['accept', 'application/json']] }),
    }),
    updateMe: build.mutation<unknown, { bio: string }>({ query: (body) => ({ url: '/me', method: 'PATCH', body }) }),
    login: build.mutation<unknown, { email: string; password: string }>({
      query: (body) => ({ url: '/auth/login', method: 'POST', body }),
    }),
    getMeRaw: build.query<unknown, undefined>({ query: () => '/me' }),
  }),
});

const SESSION_EXPIRED = sessionExpired.type;

afterEach(() => {
  vi.useRealTimers();
});

describe('requests', () => {
  it('goes to /api on the same origin with credentials "same-origin"', async () => {
    const seen = vi.fn<(request: Request) => void>();
    server.use(
      http.get(apiUrl('/friendships'), ({ request }) => {
        seen(request);
        return HttpResponse.json({ friends: [] });
      }),
    );
    const { store } = createTestStore();

    const result = await store.dispatch(testApi.endpoints.listFriendships.initiate(undefined));

    expect(result.data).toEqual({ friends: [] });
    const request = seen.mock.calls[0]?.[0];
    expect(request?.url).toBe(apiUrl('/friendships'));
    expect(request?.credentials).toBe('same-origin');
  });

  it('sends no CSRF header and fetches no token for reads', async () => {
    const tokenRequests = vi.fn();
    server.use(
      http.get(apiUrl('/csrf-token'), () => {
        tokenRequests();
        return HttpResponse.json({ token: 'unused' });
      }),
      http.get(apiUrl('/users/search'), ({ request }) => {
        expect(request.headers.has(CSRF_HEADER)).toBe(false);
        expect(new URL(request.url).searchParams.get('q')).toBe('mir');
        return HttpResponse.json({ items: [] });
      }),
    );
    const { store } = createTestStore();

    const result = await store.dispatch(testApi.endpoints.searchUsers.initiate('mir'));

    expect(result.isSuccess).toBe(true);
    expect(tokenRequests).not.toHaveBeenCalled();
  });
});

describe('CSRF (F-23)', () => {
  it('fetches the token lazily before the first mutation and sends it as x-csrf-token', async () => {
    const received: (string | null)[] = [];
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/friendships'), ({ request }) => {
        received.push(request.headers.get(CSRF_HEADER));
        return HttpResponse.json({ userId: 7, state: 'pending_outgoing' }, { status: 201 });
      }),
    );
    const { store } = createTestStore();

    const result = await store.dispatch(testApi.endpoints.sendFriendRequest.initiate({ userId: 7 }));

    expect(result.data).toEqual({ userId: 7, state: 'pending_outgoing' });
    expect(received).toEqual([TEST_CSRF_TOKEN]);
    expect(getCsrfToken()).toBe(TEST_CSRF_TOKEN);
  });

  it('loads the token once for concurrent mutations and reuses it afterwards', async () => {
    const tokenRequests = vi.fn();
    server.use(
      http.get(apiUrl('/csrf-token'), () => {
        tokenRequests();
        return HttpResponse.json({ token: TEST_CSRF_TOKEN });
      }),
      http.delete(apiUrl('/posts/:id'), ({ request }) => {
        expect(request.headers.get(CSRF_HEADER)).toBe(TEST_CSRF_TOKEN);
        expect(request.headers.get('accept')).toBe('application/json');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { store } = createTestStore();

    const results = await Promise.all([
      store.dispatch(testApi.endpoints.deletePost.initiate(41)),
      store.dispatch(testApi.endpoints.deletePost.initiate(42)),
    ]);
    await store.dispatch(testApi.endpoints.deletePost.initiate(43));

    expect(results.every((result) => result.error === undefined)).toBe(true);
    expect(tokenRequests).toHaveBeenCalledTimes(1);
  });

  it('uses the token stored by login/register without asking for one', async () => {
    setCsrfToken('token-from-login');
    server.use(
      http.patch(apiUrl('/me'), ({ request }) => {
        expect(request.headers.get(CSRF_HEADER)).toBe('token-from-login');
        return HttpResponse.json({ user: { bio: 'new' } });
      }),
    );
    const { store } = createTestStore();

    const result = await store.dispatch(testApi.endpoints.updateMe.initiate({ bio: 'new' }));

    expect(result.error).toBeUndefined();
  });

  it('retries once with a fresh token after 403 csrf-invalid', async () => {
    setCsrfToken('stale-token');
    const received: (string | null)[] = [];
    server.use(
      csrfTokenHandler('fresh-token'),
      http.post(apiUrl('/friendships'), ({ request }) => {
        const token = request.headers.get(CSRF_HEADER);
        received.push(token);
        return token === 'fresh-token'
          ? HttpResponse.json({ userId: 7, state: 'pending_outgoing' }, { status: 201 })
          : problemResponse(403, 'csrf-invalid');
      }),
    );
    const { store } = createTestStore();

    const result = await store.dispatch(testApi.endpoints.sendFriendRequest.initiate({ userId: 7 }));

    expect(result.error).toBeUndefined();
    expect(received).toEqual(['stale-token', 'fresh-token']);
    expect(getCsrfToken()).toBe('fresh-token');
  });

  it('gives up after one retry and reports csrf-invalid', async () => {
    const attempts = vi.fn();
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/friendships'), () => {
        attempts();
        return problemResponse(403, 'csrf-invalid');
      }),
    );
    const { store } = createTestStore();

    const result = await store.dispatch(testApi.endpoints.sendFriendRequest.initiate({ userId: 7 }));

    expect(attempts).toHaveBeenCalledTimes(2);
    expect(result.error).toMatchObject({ status: 403, code: 'csrf-invalid' });
  });

  it('does not retry other 403s', async () => {
    const attempts = vi.fn();
    server.use(
      csrfTokenHandler(),
      http.delete(apiUrl('/posts/:id'), () => {
        attempts();
        return problemResponse(403, 'post-delete-forbidden');
      }),
    );
    const { store } = createTestStore();

    const result = await store.dispatch(testApi.endpoints.deletePost.initiate(41));

    expect(attempts).toHaveBeenCalledTimes(1);
    expect(result.error).toMatchObject({
      code: 'post-delete-forbidden',
      message: 'Only the author or the wall owner can delete this post.',
    });
  });

  it('reports a failed token request as the mutation’s error without sending the mutation', async () => {
    const mutation = vi.fn();
    server.use(
      http.get(apiUrl('/csrf-token'), () => problemResponse(429, 'rate-limited')),
      http.post(apiUrl('/friendships'), () => {
        mutation();
        return HttpResponse.json({});
      }),
    );
    const { store } = createTestStore();

    const result = await store.dispatch(testApi.endpoints.sendFriendRequest.initiate({ userId: 7 }));

    expect(result.error).toMatchObject({ status: 429, code: 'rate-limited' });
    expect(mutation).not.toHaveBeenCalled();
    expect(getCsrfToken()).toBeNull();
  });

  it('rejects a token response that does not match the contract', async () => {
    server.use(http.get(apiUrl('/csrf-token'), () => HttpResponse.json({ csrf: 'wrong-shape' })));
    const { store } = createTestStore();

    const result = await store.dispatch(testApi.endpoints.sendFriendRequest.initiate({ userId: 7 }));

    expect(result.error).toMatchObject({ code: 'invalid-response' });
  });
});

describe('errors (problem+json, F-106)', () => {
  it('parses a problem into an ApiError with field errors', async () => {
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/auth/login'), () =>
        problemResponse(422, 'validation-failed', {
          title: 'Validation failed',
          detail: 'The request body is invalid.',
          errors: [{ location: 'body', path: 'email', message: 'Please enter a valid email address.' }],
        }),
      ),
    );
    const { store } = createTestStore();

    const result = await store.dispatch(testApi.endpoints.login.initiate({ email: 'mira', password: 'x' }));

    expect(result.error).toEqual({
      status: 422,
      code: 'validation-failed',
      title: 'Validation failed',
      detail: 'The request body is invalid.',
      errors: [{ location: 'body', path: 'email', message: 'Please enter a valid email address.' }],
      message: 'Some fields need your attention.',
    });
  });

  it('reports an unreachable server as a network error', async () => {
    server.use(http.get(apiUrl('/friendships'), () => HttpResponse.error()));
    const { store } = createTestStore();

    const result = await store.dispatch(testApi.endpoints.listFriendships.initiate(undefined));

    expect(result.error).toMatchObject({ status: 0, code: 'network' });
  });

  it('maps a non-JSON proxy page by its status', async () => {
    server.use(
      http.get(apiUrl('/friendships'), () =>
        HttpResponse.html('<html><body>502 Bad Gateway</body></html>', { status: 502 }),
      ),
    );
    const { store } = createTestStore();

    const result = await store.dispatch(testApi.endpoints.listFriendships.initiate(undefined));

    expect(result.error).toMatchObject({ status: 502, code: 'internal' });
  });

  it('maps a non-JSON 413 to file-too-large', async () => {
    server.use(
      csrfTokenHandler(),
      http.patch(apiUrl('/me'), () => HttpResponse.text('Request Entity Too Large', { status: 413 })),
    );
    const { store } = createTestStore();

    const result = await store.dispatch(testApi.endpoints.updateMe.initiate({ bio: 'x' }));

    expect(result.error).toMatchObject({ status: 413, code: 'file-too-large' });
  });

  it('reports a non-JSON success body as invalid-response', async () => {
    server.use(http.get(apiUrl('/friendships'), () => HttpResponse.text('<!doctype html><title>app</title>')));
    const { store } = createTestStore();

    const result = await store.dispatch(testApi.endpoints.listFriendships.initiate(undefined));

    expect(result.error).toMatchObject({ status: 200, code: 'invalid-response' });
  });

  it('passes Retry-After of a 429 through', async () => {
    server.use(
      http.get(apiUrl('/users/search'), () =>
        problemResponse(429, 'rate-limited', {}, { headers: { 'retry-after': '12' } }),
      ),
    );
    const { store } = createTestStore();

    const result = await store.dispatch(testApi.endpoints.searchUsers.initiate('a'));

    expect(result.error).toMatchObject({ code: 'rate-limited', retryAfterSeconds: 12 });
  });
});

describe('session expiry guard (ADR-0012, F-22)', () => {
  const unauthorized = () => problemResponse(401, 'unauthorized');

  it('a signed-in user whose request answers 401 is sent to "session expired" once', async () => {
    server.use(http.get(apiUrl('/friendships'), unauthorized));
    const { store, actionsOfType } = createTestStore();
    await signInAs(store);

    const result = await store.dispatch(testApi.endpoints.listFriendships.initiate(undefined));

    expect(result.error).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(actionsOfType(SESSION_EXPIRED)).toHaveLength(1);
  });

  it('a visitor’s 401 never dispatches sessionExpired', async () => {
    server.use(http.get(apiUrl('/friendships'), unauthorized));
    const { store, actionsOfType } = createTestStore();

    await store.dispatch(testApi.endpoints.listFriendships.initiate(undefined));

    expect(actionsOfType(SESSION_EXPIRED)).toHaveLength(0);
  });

  it('a 401 from GET /me means "visitor", even with a cached user', async () => {
    server.use(http.get(apiUrl('/me'), unauthorized));
    const { store, actionsOfType } = createTestStore();
    await signInAs(store);

    const result = await store.dispatch(testApi.endpoints.getMeRaw.initiate(undefined));

    expect(result.error).toMatchObject({ status: 401 });
    expect(actionsOfType(SESSION_EXPIRED)).toHaveLength(0);
  });

  it('a 401 from /auth/* (wrong password) is not an expiry', async () => {
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/auth/login'), () => problemResponse(401, 'invalid-credentials')),
    );
    const { store, actionsOfType } = createTestStore();
    await signInAs(store);

    const result = await store.dispatch(testApi.endpoints.login.initiate({ email: 'mira@example.com', password: 'x' }));

    expect(result.error).toMatchObject({ code: 'invalid-credentials', message: 'Email or password is incorrect.' });
    expect(actionsOfType(SESSION_EXPIRED)).toHaveLength(0);
  });

  it('a 401 from /csrf-token is not an expiry by itself', async () => {
    server.use(http.get(apiUrl('/csrf-token'), unauthorized));
    const { store, actionsOfType } = createTestStore();
    await signInAs(store);

    const result = await store.dispatch(testApi.endpoints.sendFriendRequest.initiate({ userId: 7 }));

    expect(result.error).toMatchObject({ status: 401 });
    expect(actionsOfType(SESSION_EXPIRED)).toHaveLength(0);
  });

  it('PATCH /me is an ordinary signed-in request: its 401 is an expiry', async () => {
    server.use(csrfTokenHandler(), http.patch(apiUrl('/me'), unauthorized));
    const { store, actionsOfType } = createTestStore();
    await signInAs(store);

    await store.dispatch(testApi.endpoints.updateMe.initiate({ bio: 'x' }));

    expect(actionsOfType(SESSION_EXPIRED)).toHaveLength(1);
  });

  it('after the API state is reset, later 401s are visitor 401s (no loop, message once)', async () => {
    server.use(http.get(apiUrl('/friendships'), unauthorized), http.get(apiUrl('/users/search'), unauthorized));
    const { store, actionsOfType } = createTestStore();
    await signInAs(store);

    await store.dispatch(testApi.endpoints.listFriendships.initiate(undefined));
    // What the session listener does first (app/session-listener.ts).
    store.dispatch(baseApi.util.resetApiState());
    await store.dispatch(testApi.endpoints.searchUsers.initiate('mi'));

    expect(actionsOfType(SESSION_EXPIRED)).toHaveLength(1);
  });
});
