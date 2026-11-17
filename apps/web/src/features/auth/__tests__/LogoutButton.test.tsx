import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestStore, MIRA, signInAs } from '../../../shared/api/__tests__/fixtures';
import { getCsrfToken, setCsrfToken } from '../../../shared/api/csrf';
import { meApi } from '../../../shared/api/me.api';
import { connectRealtime, disconnectRealtime } from '../../../shared/realtime/socket';
import { apiUrl, http, HttpResponse, problemResponse, server } from '../../../shared/test/msw';
import { renderWithProviders } from '../../../shared/test/render';
import { LogoutButton } from '../components/LogoutButton';

/** What happened, in order: the socket calls and the logout request (ADR-0012 fixes the order). */
const events = vi.hoisted((): string[] => []);

// The tab's real socket would try to connect; the test records the lifecycle calls instead.
vi.mock('../../../shared/realtime/socket', () => ({
  disconnectRealtime: vi.fn(() => {
    events.push('disconnect socket');
  }),
  connectRealtime: vi.fn(() => {
    events.push('connect socket');
  }),
}));

const SESSION_TOKEN = 'token-of-the-signed-in-session';

beforeEach(() => {
  events.length = 0;
  vi.mocked(disconnectRealtime).mockClear();
  vi.mocked(connectRealtime).mockClear();
});

/** A signed-in user on `/chat` with the header's button; `/welcome/login` is a stand-in that proves the navigation. */
async function renderSignedIn() {
  const { store, actionsOfType } = createTestStore();
  await signInAs(store, MIRA);
  setCsrfToken(SESSION_TOKEN);
  const rendered = renderWithProviders(<LogoutButton />, {
    store,
    path: '/chat',
    initialEntries: ['/friends', '/chat'],
    routes: [{ path: '/welcome/login', element: <h1>Log in</h1> }],
  });
  const signedInUser = () => meApi.endpoints.getMe.select(undefined)(store.getState()).data;
  return { ...rendered, actionsOfType, signedInUser };
}

/** `POST /api/auth/logout` with `answer`; records the request (B-18: a GET would have no handler and fail). */
function logoutAnswers(answer: () => Response | Promise<Response>) {
  const csrfHeaders: (string | null)[] = [];
  server.use(
    http.post(apiUrl('/auth/logout'), ({ request }) => {
      events.push('POST /api/auth/logout');
      csrfHeaders.push(request.headers.get('x-csrf-token'));
      return answer();
    }),
  );
  return csrfHeaders;
}

describe('LogoutButton', () => {
  it('F-92: is a "log out" button, not a link', async () => {
    await renderSignedIn();

    const button = screen.getByRole('button', { name: 'log out' });
    expect(button).toHaveAttribute('type', 'button');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('F-20, B-18: disconnects the socket, posts logout with CSRF, clears the token, resets the API state and goes to /welcome/login', async () => {
    const csrfHeaders = logoutAnswers(() => new HttpResponse(null, { status: 204 }));
    const { user, router, signedInUser } = await renderSignedIn();

    await user.click(screen.getByRole('button', { name: 'log out' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/welcome/login');
    // Replaced, so "back" does not return to a page of the ended session.
    expect(router.state.historyAction).toBe('REPLACE');
    expect(events).toEqual(['disconnect socket', 'POST /api/auth/logout']);
    expect(csrfHeaders).toEqual([SESSION_TOKEN]);
    expect(getCsrfToken()).toBeNull();
    expect(signedInUser()).toBeUndefined();
    expect(connectRealtime).not.toHaveBeenCalled();
  });

  it('F-20, F-22: a session that had already ended (401) is logged out all the same, without the expiry message', async () => {
    logoutAnswers(() => problemResponse(401, 'unauthorized'));
    const { user, router, signedInUser, actionsOfType } = await renderSignedIn();

    await user.click(screen.getByRole('button', { name: 'log out' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();
    expect(router.state.location.search).toBe('');
    expect(actionsOfType('session/expired')).toHaveLength(0);
    expect(getCsrfToken()).toBeNull();
    expect(signedInUser()).toBeUndefined();
  });

  it('F-20, F-107: a failed logout keeps the user signed in, reconnects the socket as resumed and says so', async () => {
    logoutAnswers(() => problemResponse(500, 'internal'));
    const { user, router, signedInUser } = await renderSignedIn();

    await user.click(screen.getByRole('button', { name: 'log out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You are still logged in. Something went wrong on our side. Please try again.',
    );
    expect(router.state.location.pathname).toBe('/chat');
    expect(events).toEqual(['disconnect socket', 'POST /api/auth/logout', 'connect socket']);
    // Events of the seconds without a socket are lost: the reconnect resyncs the real-time caches.
    expect(connectRealtime).toHaveBeenCalledExactlyOnceWith(expect.anything(), { resume: true });
    expect(getCsrfToken()).toBe(SESSION_TOKEN);
    expect(signedInUser()).toEqual({ user: MIRA });
    expect(screen.getByRole('button', { name: 'log out' })).toBeEnabled();
  });

  it('F-20: can try again after a network failure', async () => {
    let online = false;
    logoutAnswers(() => (online ? new HttpResponse(null, { status: 204 }) : HttpResponse.error()));
    const { user, router } = await renderSignedIn();

    await user.click(screen.getByRole('button', { name: 'log out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You are still logged in. The server could not be reached. Check your connection and try again.',
    );

    online = true;
    await user.click(screen.getByRole('button', { name: 'log out' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/welcome/login');
  });

  it('F-13: is disabled and busy while the request runs; a double click posts once', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const csrfHeaders = logoutAnswers(async () => {
      await gate;
      return new HttpResponse(null, { status: 204 });
    });
    const { user } = await renderSignedIn();

    await user.dblClick(screen.getByRole('button', { name: 'log out' }));

    const busy = await screen.findByRole('button', { name: 'logging out…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');

    release();

    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();
    await waitFor(() => {
      expect(csrfHeaders).toHaveLength(1);
    });
    expect(disconnectRealtime).toHaveBeenCalledTimes(1);
  });
});
