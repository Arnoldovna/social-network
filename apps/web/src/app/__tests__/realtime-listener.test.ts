import { describe, expect, it, vi } from 'vitest';

import { MIRA } from '../../shared/api/__tests__/fixtures';
import { baseApi } from '../../shared/api/baseApi';
import { meApi } from '../../shared/api/me.api';
import { realtimeActions } from '../../shared/realtime/realtimeSlice';
import { connectRealtime, disconnectRealtime } from '../../shared/realtime/socket';
import { apiUrl, HttpResponse, http, server } from '../../shared/test/msw';
import { RESYNC_TAGS, startRealtimeListener } from '../realtime-listener';
import { createAppStore } from '../store';

// The socket lifecycle itself is tested in shared/realtime; here only when the listener calls it.
vi.mock('../../shared/realtime/socket', () => ({ connectRealtime: vi.fn(), disconnectRealtime: vi.fn() }));

async function signIn(store: ReturnType<typeof createAppStore>) {
  await store.dispatch(meApi.util.upsertQueryData('getMe', undefined, { user: MIRA }));
}

describe('startRealtimeListener: socket follows the session (F-03, ADR-0012)', () => {
  it('connects once the getMe cache holds a user, and not again while signed in', async () => {
    const store = createAppStore();
    startRealtimeListener(store);
    expect(connectRealtime).not.toHaveBeenCalled();

    await signIn(store);
    await signIn(store); // e.g. updateMe or the avatar upload writing a new Me
    store.dispatch(realtimeActions.connected({ resumed: false }));

    expect(connectRealtime).toHaveBeenCalledTimes(1);
    expect(connectRealtime).toHaveBeenCalledWith(store);
  });

  it('connects when the app loader’s GET /api/me succeeds', async () => {
    server.use(http.get(apiUrl('/me'), () => HttpResponse.json({ user: MIRA })));
    const store = createAppStore();
    startRealtimeListener(store);

    await store.dispatch(meApi.endpoints.getMe.initiate(undefined, { subscribe: false }));

    expect(connectRealtime).toHaveBeenCalledTimes(1);
  });

  it('connects right away when the store starts with a user', async () => {
    const signedIn = createAppStore();
    await signIn(signedIn);
    const store = createAppStore(signedIn.getState());

    startRealtimeListener(store);

    expect(connectRealtime).toHaveBeenCalledTimes(1);
  });

  it('disconnects when logout or expiry reset the API state', async () => {
    const store = createAppStore();
    startRealtimeListener(store);
    await signIn(store);

    store.dispatch(baseApi.util.resetApiState());

    expect(disconnectRealtime).toHaveBeenCalledTimes(1);
  });

  it('stops after its unsubscribe function ran', async () => {
    const store = createAppStore();
    const stop = startRealtimeListener(store);

    stop();
    await signIn(store);

    expect(connectRealtime).not.toHaveBeenCalled();
  });
});

describe('startRealtimeListener: resync after a reconnect (F-107, ADR-0008)', () => {
  const resyncApi = baseApi.injectEndpoints({
    endpoints: (build) => ({
      resyncProbe: build.query<unknown, (typeof RESYNC_TAGS)[number]>({
        query: (tag) => `/presence?tag=${tag}`,
        providesTags: (_result, _error, tag) => [tag],
      }),
    }),
  });

  it('refetches the wall, friendship, presence and chat caches when a dropped connection comes back', async () => {
    const requested: string[] = [];
    server.use(
      http.get(apiUrl('/presence'), ({ request }) => {
        requested.push(new URL(request.url).searchParams.get('tag') ?? '');
        return HttpResponse.json({ items: [] });
      }),
    );
    const store = createAppStore();
    startRealtimeListener(store);
    const subscriptions = RESYNC_TAGS.map((tag) => store.dispatch(resyncApi.endpoints.resyncProbe.initiate(tag)));
    await Promise.all(subscriptions);
    expect(requested).toHaveLength(4);

    store.dispatch(realtimeActions.connected({ resumed: true }));

    await vi.waitFor(() => {
      expect(requested).toHaveLength(8);
    });
    expect(requested.slice(4).sort()).toEqual(['Chat', 'Friendships', 'Presence', 'Wall']);
    subscriptions.forEach((subscription) => {
      subscription.unsubscribe();
    });
  });

  it('does not refetch on the first connect of a session', async () => {
    let requests = 0;
    server.use(
      http.get(apiUrl('/presence'), () => {
        requests += 1;
        return HttpResponse.json({ items: [] });
      }),
    );
    const store = createAppStore();
    startRealtimeListener(store);
    const subscription = store.dispatch(resyncApi.endpoints.resyncProbe.initiate('Presence'));
    await subscription;

    store.dispatch(realtimeActions.connected({ resumed: false }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requests).toBe(1);
    subscription.unsubscribe();
  });
});
