import type { Unsubscribe } from '@reduxjs/toolkit';

import { baseApi } from '../shared/api/baseApi';
import type { TagType } from '../shared/api/baseApi';
import { selectIsAuthenticated } from '../shared/api/me.api';
import { realtimeActions } from '../shared/realtime/realtimeSlice';
import { connectRealtime, disconnectRealtime } from '../shared/realtime/socket';
import { addAppListener } from './store';
import type { AppStore } from './store';

/**
 * Caches that socket events keep up to date. After a dropped connection the events in between are lost (the server
 * runs without connection-state recovery, API.md §3), so these are refetched over HTTP. Invalidating `Chat` refetches
 * the chat history from its newest page; each wall entry re-joins its room on `connect` itself (OVERVIEW §7).
 */
export const RESYNC_TAGS = ['Wall', 'Friendships', 'Presence', 'Chat'] as const satisfies readonly TagType[];

/**
 * Ties the tab's single socket to the session (ADR-0008, ADR-0012, F-03, F-107):
 * - it connects as soon as the `getMe` cache holds a user (the app loader's `getMe`, or login/register writing the
 *   user into it) and never again while signed in, so client-side navigation keeps the same socket;
 * - it disconnects when the user is gone from the cache (logout or expiry reset the API state); `LogoutButton` and
 *   the session listener close the socket themselves first, so this is the safety net;
 * - a `connect` that ends a `reconnecting` phase invalidates the real-time-backed caches.
 *
 * Returns one function that removes both listeners; `main.tsx` calls this once.
 */
export function startRealtimeListener(store: AppStore): Unsubscribe {
  const stopSession = store.dispatch(
    addAppListener({
      predicate: (_action, currentState, previousState) =>
        selectIsAuthenticated(currentState) !== selectIsAuthenticated(previousState),
      effect: (_action, listenerApi) => {
        if (selectIsAuthenticated(listenerApi.getState())) {
          connectRealtime(store);
        } else {
          disconnectRealtime();
        }
      },
    }),
  );

  const stopResync = store.dispatch(
    addAppListener({
      actionCreator: realtimeActions.connected,
      effect: (action, listenerApi) => {
        if (action.payload.resumed) {
          listenerApi.dispatch(baseApi.util.invalidateTags([...RESYNC_TAGS]));
        }
      },
    }),
  );

  // A user who is already in the cache (a store created with preloaded state) is connected right away.
  if (selectIsAuthenticated(store.getState())) {
    connectRealtime(store);
  }

  return () => {
    stopSession();
    stopResync();
  };
}
