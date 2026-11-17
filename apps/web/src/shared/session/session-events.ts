import { createAction } from '@reduxjs/toolkit';

/**
 * The signed-in user's session is gone (idle TTL, logout in another tab, server restart): the next API call answered
 * 401, the server closed the socket (`io server disconnect`) or rejected its handshake with `unauthorized`.
 *
 * Dispatched only for a client that **was authenticated** when the signal arrived (ADR-0012): the base query and the
 * socket lifecycle check `selectIsAuthenticated` first, so a visitor's 401 from `/api/me` never shows "Your session
 * has expired". `app/session-listener.ts` handles it: clears the CSRF token, disconnects the socket, resets the API
 * state (which turns `selectIsAuthenticated` false, so the message appears exactly once) and navigates to
 * `/welcome/login?reason=expired` (F-22).
 */
export const sessionExpired = createAction('session/expired');
