import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Provider } from 'react-redux';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestStore, MIRA, signInAs } from '../../api/__tests__/fixtures';
import { baseApi } from '../../api/baseApi';
import { meApi } from '../../api/me.api';
import { apiUrl, HttpResponse, http, problemResponse, server } from '../../test/msw';
import { useCurrentUser } from '../use-current-user';

function setup() {
  const testStore = createTestStore();
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={testStore.store}>{children}</Provider>;
  return { ...testStore, wrapper };
}

describe('useCurrentUser', () => {
  afterEach(() => {
    cleanup();
  });

  it('returns the cached user without another request', async () => {
    const meRequests = vi.fn();
    server.use(
      http.get(apiUrl('/me'), () => {
        meRequests();
        return HttpResponse.json({ user: MIRA });
      }),
    );
    const { store, wrapper } = setup();
    await signInAs(store);

    const { result } = renderHook(() => useCurrentUser(), { wrapper });

    expect(result.current).toEqual(MIRA);
    expect(meRequests).not.toHaveBeenCalled();
  });

  it('loads the user when the cache is empty', async () => {
    server.use(http.get(apiUrl('/me'), () => HttpResponse.json({ user: MIRA })));
    const { wrapper } = setup();

    const { result } = renderHook(() => useCurrentUser(), { wrapper });

    expect(result.current).toBeNull();
    await waitFor(() => {
      expect(result.current).toEqual(MIRA);
    });
  });

  it('re-renders with the new data when the cache entry changes (bio, avatar, F-37)', async () => {
    const { store, wrapper } = setup();
    await signInAs(store);
    const { result } = renderHook(() => useCurrentUser(), { wrapper });

    const avatarUrl = '/api/users/1/avatar?v=0b8e5f3c-2d47-4a61-9c1e-7f2a3b4c5d6e';
    act(() => {
      store.dispatch(
        meApi.util.updateQueryData('getMe', undefined, (draft) => {
          draft.user.avatarUrl = avatarUrl;
        }),
      );
    });

    await waitFor(() => {
      expect(result.current?.avatarUrl).toBe(avatarUrl);
    });
  });

  it('returns null for a visitor', async () => {
    server.use(http.get(apiUrl('/me'), () => problemResponse(401, 'unauthorized')));
    const { store, wrapper } = setup();

    const { result } = renderHook(() => useCurrentUser(), { wrapper });

    await waitFor(() => {
      expect(meApi.endpoints.getMe.select(undefined)(store.getState()).isError).toBe(true);
    });
    expect(result.current).toBeNull();
  });

  it('returns null once logout or expiry reset the API state', async () => {
    server.use(http.get(apiUrl('/me'), () => problemResponse(401, 'unauthorized')));
    const { store, wrapper } = setup();
    await signInAs(store);
    const { result } = renderHook(() => useCurrentUser(), { wrapper });
    expect(result.current).toEqual(MIRA);

    act(() => {
      store.dispatch(baseApi.util.resetApiState());
    });

    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });
});
