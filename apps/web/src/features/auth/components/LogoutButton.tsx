import { useRef, useState } from 'react';
import { useDispatch, useStore } from 'react-redux';
import { useNavigate } from 'react-router';

import { baseApi } from '../../../shared/api/baseApi';
import { clearCsrfToken } from '../../../shared/api/csrf';
import { errorMessage, isApiError } from '../../../shared/api/problem';
import { connectRealtime, disconnectRealtime } from '../../../shared/realtime/socket';
import { Button } from '../../../shared/ui/Button';
import { FieldError } from '../../../shared/ui/FieldError';
import { useLogoutMutation } from '../auth.api';
import './LogoutButton.css';

/** Where a finished logout lands (F-20, B-18). */
export const LOGGED_OUT_PATH = '/welcome/login';

/**
 * "log out" in the header (F-20, B-18, ADR-0012). The order matters:
 * 1. close this tab's socket first, so it never sees the server's disconnect of the destroyed session and never
 *    shows "Your session has expired";
 * 2. `POST /api/auth/logout` with the CSRF token (the base query adds it);
 * 3. drop the CSRF token, which was bound to the destroyed session, so the next login fetches a fresh one;
 * 4. reset the API state, so no data of this user survives and the welcome guard sees a visitor;
 * 5. go to `/welcome/login`, replacing the current entry, so "back" does not return to a page of the old session.
 *
 * A 401 means the session had already ended (expired, or logged out in another tab), so the logout is complete all the
 * same. Any other failure (network, 5xx, 429) leaves the user signed in on the server: the page stays, the socket
 * reconnects and a message says so, instead of pretending a logout that did not happen. The reconnect counts as resumed
 * (`resume: true`): chat messages, presence and friendship events of the seconds without a socket are lost, so the
 * real-time caches are refetched as after any other gap (F-107).
 */
export function LogoutButton() {
  const [logout, { isLoading }] = useLogoutMutation();
  const dispatch = useDispatch();
  const store = useStore();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // A second click before the re-render disabled the button must not start a second logout.
  const inFlight = useRef(false);

  const handleClick = async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setError(null);
    disconnectRealtime();

    const result = await logout(undefined);
    const failure = result.error;
    if (failure !== undefined && !(isApiError(failure) && failure.status === 401)) {
      connectRealtime(store, { resume: true });
      setError(`You are still logged in. ${errorMessage(failure)}`);
      inFlight.current = false;
      return;
    }

    clearCsrfToken();
    dispatch(baseApi.util.resetApiState());
    await navigate(LOGGED_OUT_PATH, { replace: true });
  };

  return (
    <div className="logout-button">
      <Button
        className="logout-button__button"
        disabled={isLoading}
        aria-busy={isLoading ? true : undefined}
        onClick={() => {
          void handleClick();
        }}
      >
        {isLoading ? 'logging out…' : 'log out'}
      </Button>
      <FieldError>{error ?? undefined}</FieldError>
    </div>
  );
}
