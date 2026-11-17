import type { Unsubscribe } from '@reduxjs/toolkit';

import { baseApi } from '../shared/api/baseApi';
import { clearCsrfToken } from '../shared/api/csrf';
import { selectIsAuthenticated } from '../shared/api/me.api';
import { disconnectRealtime } from '../shared/realtime/socket';
import { sessionExpired } from '../shared/session/session-events';
import { addAppListener } from './store';
import type { AppStore } from './store';

/** Where an expired session ends up; `LoginPage` shows "Your session has expired. Please log in again." (F-22). */
export const SESSION_EXPIRED_PATH = '/welcome/login?reason=expired';

/**
 * The navigation the listener needs, injected from `main.tsx` as `router.navigate` (ADR-0012). Typed structurally,
 * so this module never imports the router and tests can pass a spy.
 */
export type NavigateTo = (to: string, options?: { replace?: boolean }) => Promise<void> | void;

/**
 * Handles `sessionExpired` (F-22, ADR-0012), which the base query and the socket lifecycle dispatch only for a client
 * that was signed in:
 * 1. reset the API state first, so `selectIsAuthenticated` turns false and every later 401 (requests still in flight,
 *    the welcome loader's own `getMe`) is a visitor 401: the message appears once and no loop is possible;
 * 2. drop the CSRF token (it is bound to the old session);
 * 3. close the socket and cancel any handshake retry;
 * 4. replace the current entry with the login page, so "back" does not return to a page that needs the old session.
 *
 * Returns the unsubscribe function; `main.tsx` calls this once.
 */
export function startSessionListener(store: AppStore, navigate: NavigateTo): Unsubscribe {
  return store.dispatch(
    addAppListener({
      actionCreator: sessionExpired,
      effect: (_action, listenerApi) => {
        // A second signal for the same expiry (e.g. a 401 and the socket close) finds the client already signed out.
        if (!selectIsAuthenticated(listenerApi.getOriginalState())) {
          return;
        }
        listenerApi.dispatch(baseApi.util.resetApiState());
        clearCsrfToken();
        disconnectRealtime();
        void navigate(SESSION_EXPIRED_PATH, { replace: true });
      },
    }),
  );
}
