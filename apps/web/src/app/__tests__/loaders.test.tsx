import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MIRA } from '../../shared/api/__tests__/fixtures';
import { baseApi } from '../../shared/api/baseApi';
import { meApi } from '../../shared/api/me.api';
import { sessionExpired } from '../../shared/session/session-events';
import { apiUrl, HttpResponse, http, problemResponse, server } from '../../shared/test/msw';
import { renderRoutes } from '../../shared/test/render';
import { createRoutes } from '../router';
import { startSessionListener } from '../session-listener';
import { addAppListener, createAppStore } from '../store';
import type { AppStore } from '../store';
import { SESSION_EXPIRED_MESSAGE } from './fakes';

// Rule 7: the shell is tested against stand-ins, never against a sibling feature's real component.
vi.mock('../../features/auth', async () => (await import('./fakes')).authFeature);
vi.mock('../../features/profile', async () => (await import('./fakes')).profileFeature);
vi.mock('../../features/avatars', async () => (await import('./fakes')).avatarsFeature);
vi.mock('../../features/friends', async () => (await import('./fakes')).friendsFeature);
vi.mock('../../features/search', async () => (await import('./fakes')).searchFeature);
vi.mock('../../features/chat', async () => (await import('./fakes')).chatFeature);
vi.mock('../../features/presence', async () => (await import('./fakes')).presenceFeature);

/** A signed-in request whose answer tells the client its session is gone (any non-probe endpoint behaves the same). */
const probeApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    // The argument makes separate cache entries, so two calls are two real requests (RTK Query dedupes equal ones).
    loadersProbe: build.query<unknown, number | string>({ query: (call) => `/friendships?call=${String(call)}` }),
  }),
});

function countExpiries(store: AppStore): () => number {
  let count = 0;
  store.dispatch(
    addAppListener({
      actionCreator: sessionExpired,
      effect: () => {
        count += 1;
      },
    }),
  );
  return () => count;
}

/**
 * The app's route table on a memory router, with the app's store and the session listener as in `main.tsx`. `path` is
 * the URL to open, or a whole history whose last entry is the current URL.
 */
function renderApp(path: string | string[]) {
  const store = createAppStore();
  const expiries = countExpiries(store);
  const initialEntries = typeof path === 'string' ? [path] : path;
  const rendered = renderRoutes(createRoutes(store), { store, initialEntries });
  startSessionListener(store, (to, options) => rendered.router.navigate(to, options));
  const location = () => rendered.router.state.location;
  return { ...rendered, store, expiries, location };
}

function visitorSession() {
  const meRequests = vi.fn();
  server.use(
    http.get(apiUrl('/me'), () => {
      meRequests();
      return problemResponse(401, 'unauthorized');
    }),
  );
  return { meRequests };
}

function signedInSession() {
  const meRequests = vi.fn();
  server.use(
    http.get(apiUrl('/me'), () => {
      meRequests();
      return HttpResponse.json({ user: MIRA });
    }),
  );
  return { meRequests };
}

describe('requireUser (F-01)', () => {
  it.each(['/', '/users/7', '/friends', '/online', '/chat'])(
    'F-01: sends a visitor from %s to /welcome without a reason',
    async (path) => {
      visitorSession();
      const { location, expiries } = renderApp(path);

      expect(await screen.findByRole('heading', { level: 1, name: 'Sign up' })).toBeInTheDocument();
      expect(location().pathname).toBe('/welcome');
      expect(location().search).toBe('');
      expect(expiries()).toBe(0);
      expect(screen.queryByText(SESSION_EXPIRED_MESSAGE)).not.toBeInTheDocument();
    },
  );

  it('F-01: renders the app page for a signed-in user and keeps the user cached for later pages', async () => {
    const { meRequests } = signedInSession();
    const { store, location, router } = renderApp('/');

    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
    expect(location().pathname).toBe('/');
    expect(meApi.endpoints.getMe.select(undefined)(store.getState()).data).toEqual({ user: MIRA });

    await router.navigate('/friends');

    expect(await screen.findByRole('heading', { level: 1, name: 'Friends' })).toBeInTheDocument();
    expect(meRequests).toHaveBeenCalledTimes(1);
  });

  it('F-01: does not render the protected page before the guard has answered', async () => {
    visitorSession();
    renderApp('/chat');

    expect(screen.queryByRole('heading', { name: 'Chat' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign up' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Chat' })).not.toBeInTheDocument();
  });
});

describe('redirectIfAuthenticated (F-02)', () => {
  it.each(['/welcome', '/welcome/login', '/welcome/about'])(
    'F-02: sends a signed-in user from %s to /',
    async (path) => {
      signedInSession();
      const { location } = renderApp(path);

      expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
      expect(location().pathname).toBe('/');
    },
  );

  it('F-02: does not render the welcome page before the guard has answered', async () => {
    signedInSession();
    renderApp('/welcome/login');

    expect(screen.queryByRole('heading', { name: 'Log in' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Log in' })).not.toBeInTheDocument();
  });

  it.each([
    ['/welcome', 'Sign up'],
    ['/welcome/login', 'Log in'],
    ['/welcome/about', 'About'],
  ])('F-02, F-22: a visitor stays on %s without reason=expired and without sessionExpired', async (path, heading) => {
    visitorSession();
    const { location, expiries } = renderApp(path);

    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(location().pathname).toBe(path);
    expect(location().search).not.toContain('reason=expired');
    expect(expiries()).toBe(0);
    expect(screen.queryByText(SESSION_EXPIRED_MESSAGE)).not.toBeInTheDocument();
  });
});

describe('redirectIfOwnProfile (F-41)', () => {
  it('F-41: sends the user from their own /users/:id to /', async () => {
    signedInSession();
    const { location } = renderApp(`/users/${String(MIRA.id)}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
    expect(location().pathname).toBe('/');
  });

  it.each(['7', '01', 'abc'])(
    'F-41: renders the profile page for /users/%s (other users and ids that do not parse)',
    async (id) => {
      signedInSession();
      const { location } = renderApp(`/users/${id}`);

      expect(await screen.findByRole('heading', { level: 1, name: `User ${id}` })).toBeInTheDocument();
      expect(location().pathname).toBe(`/users/${id}`);
    },
  );

  it('F-41: the app guard and the profile guard run in parallel and share one GET /api/me', async () => {
    const { meRequests } = signedInSession();
    renderApp('/users/7');

    expect(await screen.findByRole('heading', { level: 1, name: 'User 7' })).toBeInTheDocument();
    expect(meRequests).toHaveBeenCalledTimes(1);
  });

  it('F-01: a visitor deep link to /users/:id asks GET /api/me once per navigation, never in a loop', async () => {
    const { meRequests } = visitorSession();
    const { location, expiries } = renderApp(`/users/${String(MIRA.id)}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign up' })).toBeInTheDocument();
    expect(location().pathname).toBe('/welcome');
    expect(location().search).toBe('');
    expect(expiries()).toBe(0);
    // One request per navigation: the two parallel guards of /users/:id share the first, and the welcome guard of the
    // redirect asks again (RTK Query refetches a failed entry). No guard loops on the visitor answer.
    expect(meRequests).toHaveBeenCalledTimes(2);
  });
});

describe('session expiry while the app is open (F-22, ADR-0012)', () => {
  it('F-22: a signed-in user whose next call returns 401 lands on /welcome/login?reason=expired and sees the message once', async () => {
    let sessionAlive = true;
    let friendshipRequests = 0;
    server.use(
      http.get(apiUrl('/me'), () =>
        sessionAlive ? HttpResponse.json({ user: MIRA }) : problemResponse(401, 'unauthorized'),
      ),
      http.get(apiUrl('/friendships'), () => {
        friendshipRequests += 1;
        sessionAlive = false;
        return problemResponse(401, 'unauthorized');
      }),
    );
    const { store, location, expiries } = renderApp('/friends');
    expect(await screen.findByRole('heading', { level: 1, name: 'Friends' })).toBeInTheDocument();

    // Two requests fail at once (a page and the header both loading): still one expiry, one message.
    await Promise.all([
      store.dispatch(probeApi.endpoints.loadersProbe.initiate(1)),
      store.dispatch(probeApi.endpoints.loadersProbe.initiate(2)),
    ]);

    expect(friendshipRequests).toBe(2);
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();
    expect(location().pathname).toBe('/welcome/login');
    expect(location().search).toBe('?reason=expired');
    expect(screen.getAllByText(SESSION_EXPIRED_MESSAGE)).toHaveLength(1);
    expect(expiries()).toBe(1);
    // The welcome loader's own GET /me answered 401 too; as a visitor 401 it changed nothing.
    await waitFor(() => {
      expect(meApi.endpoints.getMe.select(undefined)(store.getState()).isError).toBe(true);
    });
    expect(expiries()).toBe(1);
    expect(screen.getAllByText(SESSION_EXPIRED_MESSAGE)).toHaveLength(1);
  });

  it('F-22: replaces the history entry, so "back" does not return to the page of the old session', async () => {
    let sessionAlive = true;
    server.use(
      http.get(apiUrl('/me'), () =>
        sessionAlive ? HttpResponse.json({ user: MIRA }) : problemResponse(401, 'unauthorized'),
      ),
      http.get(apiUrl('/friendships'), () => {
        sessionAlive = false;
        return problemResponse(401, 'unauthorized');
      }),
    );
    const { store, router, location } = renderApp(['/friends', '/chat']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Chat' })).toBeInTheDocument();

    await store.dispatch(probeApi.endpoints.loadersProbe.initiate(1));

    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();
    expect(router.state.historyAction).toBe('REPLACE');

    // "Back" skips the replaced /chat entry: it reaches the page before it, whose guard now sees a visitor.
    await router.navigate(-1);

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign up' })).toBeInTheDocument();
    expect(location().pathname).toBe('/welcome');
    expect(screen.queryByRole('heading', { name: 'Chat' })).not.toBeInTheDocument();
  });

  it('F-22: a request still in flight when the session expires is cancelled and never shows a second message', async () => {
    let sessionAlive = true;
    // A holder, not a `let`: the handler assigns it later, which control-flow narrowing cannot see.
    const slowCall: { signal?: AbortSignal } = {};
    let releaseSlowRequest = (): void => undefined;
    const slowRequestReleased = new Promise<void>((resolve) => {
      releaseSlowRequest = resolve;
    });
    server.use(
      http.get(apiUrl('/me'), () =>
        sessionAlive ? HttpResponse.json({ user: MIRA }) : problemResponse(401, 'unauthorized'),
      ),
      http.get(apiUrl('/friendships'), async ({ request }) => {
        if (new URL(request.url).searchParams.get('call') === 'slow') {
          slowCall.signal = request.signal;
          await slowRequestReleased;
        }
        sessionAlive = false;
        return problemResponse(401, 'unauthorized');
      }),
    );
    const { store, location, expiries } = renderApp('/online');
    expect(await screen.findByRole('heading', { level: 1, name: 'Online' })).toBeInTheDocument();

    const slowRequest = store.dispatch(probeApi.endpoints.loadersProbe.initiate('slow'));
    await waitFor(() => {
      expect(slowCall.signal).toBeDefined();
    });
    await store.dispatch(probeApi.endpoints.loadersProbe.initiate('fast'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();

    // Resetting the API state cancelled the request of the old session that was still waiting for its answer.
    expect(slowCall.signal?.aborted).toBe(true);
    releaseSlowRequest();
    await slowRequest;

    expect(expiries()).toBe(1);
    expect(probeApi.endpoints.loadersProbe.select('slow')(store.getState()).isUninitialized).toBe(true);
    expect(location().pathname).toBe('/welcome/login');
    expect(location().search).toBe('?reason=expired');
    expect(screen.getAllByText(SESSION_EXPIRED_MESSAGE)).toHaveLength(1);
  });
});
