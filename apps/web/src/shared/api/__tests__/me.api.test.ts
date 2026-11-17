import { afterEach, describe, expect, it, vi } from 'vitest';

import { sessionExpired } from '../../session/session-events';
import { apiUrl, HttpResponse, http, problemResponse, server } from '../../test/msw';
import { baseApi } from '../baseApi';
import { meApi, selectCurrentUser, selectIsAuthenticated } from '../me.api';
import { createTestStore, MIRA, signInAs } from './fixtures';

afterEach(() => {
  vi.useRealTimers();
});

describe('getMe', () => {
  it('loads the signed-in user from GET /api/me (F-21)', async () => {
    server.use(http.get(apiUrl('/me'), () => HttpResponse.json({ user: MIRA })));
    const { store } = createTestStore();

    const result = await store.dispatch(meApi.endpoints.getMe.initiate(undefined));

    expect(result.data).toEqual({ user: MIRA });
    expect(selectCurrentUser(store.getState())).toEqual(MIRA);
    expect(selectIsAuthenticated(store.getState())).toBe(true);
  });

  it('treats a 401 as a visitor: no user, no session expiry', async () => {
    server.use(http.get(apiUrl('/me'), () => problemResponse(401, 'unauthorized')));
    const { store, actionsOfType } = createTestStore();

    const result = await store.dispatch(meApi.endpoints.getMe.initiate(undefined));

    expect(result.error).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(selectCurrentUser(store.getState())).toBeNull();
    expect(selectIsAuthenticated(store.getState())).toBe(false);
    expect(actionsOfType(sessionExpired.type)).toHaveLength(0);
  });

  it('rejects a response with private fields instead of caching them (strict contract, B-19)', async () => {
    server.use(
      http.get(apiUrl('/me'), () => HttpResponse.json({ user: { ...MIRA, email: 'mira.novak@example.com' } })),
    );
    const { store } = createTestStore();

    const result = await store.dispatch(meApi.endpoints.getMe.initiate(undefined));

    expect(result.error).toMatchObject({ code: 'invalid-response' });
    expect(selectIsAuthenticated(store.getState())).toBe(false);
  });

  it('rejects a response that is not the MeResponse envelope', async () => {
    server.use(http.get(apiUrl('/me'), () => HttpResponse.json(MIRA)));
    const { store } = createTestStore();

    const result = await store.dispatch(meApi.endpoints.getMe.initiate(undefined));

    expect(result.error).toMatchObject({ code: 'invalid-response' });
  });

  it('keeps the user cached after the last subscriber left', async () => {
    server.use(http.get(apiUrl('/me'), () => HttpResponse.json({ user: MIRA })));
    const { store } = createTestStore();
    const subscription = store.dispatch(meApi.endpoints.getMe.initiate(undefined));
    await subscription;

    vi.useFakeTimers();
    subscription.unsubscribe();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);

    expect(selectIsAuthenticated(store.getState())).toBe(true);
  });
});

describe('selectIsAuthenticated', () => {
  it('is false for a fresh store', () => {
    const { store } = createTestStore();
    expect(selectIsAuthenticated(store.getState())).toBe(false);
    expect(selectCurrentUser(store.getState())).toBeNull();
  });

  it('is true once login/register wrote the user into the cache', async () => {
    const { store } = createTestStore();
    await signInAs(store);
    expect(selectCurrentUser(store.getState())).toEqual(MIRA);
    expect(selectIsAuthenticated(store.getState())).toBe(true);
  });

  it('is false again after logout/expiry reset the API state', async () => {
    const { store } = createTestStore();
    await signInAs(store);

    store.dispatch(baseApi.util.resetApiState());

    expect(selectIsAuthenticated(store.getState())).toBe(false);
  });
});
