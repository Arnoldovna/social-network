import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MIRA } from '../../shared/api/__tests__/fixtures';
import { baseApi } from '../../shared/api/baseApi';
import { getCsrfToken, setCsrfToken } from '../../shared/api/csrf';
import { meApi, selectIsAuthenticated } from '../../shared/api/me.api';
import { selectRealtimeStatus } from '../../shared/realtime/realtimeSlice';
import { connectRealtime, HANDSHAKE_RETRY_MS } from '../../shared/realtime/socket';
import { sessionExpired } from '../../shared/session/session-events';
import { apiUrl, http, problemResponse, server } from '../../shared/test/msw';
import { SESSION_EXPIRED_PATH, startSessionListener } from '../session-listener';
import { createAppStore } from '../store';

type Handler = (...args: unknown[]) => void;

/**
 * Just enough of socket.io-client's `Socket` for the session paths: the tab's one socket is a module singleton, so
 * the file shares one fake and `reset()` puts it back to "never connected" before each test.
 */
class FakeSocket {
  connected = false;
  active = false;
  private readonly handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  readonly connect = vi.fn(() => {
    this.active = true;
    return this;
  });

  readonly disconnect = vi.fn(() => {
    this.connected = false;
    this.active = false;
    return this;
  });

  reset(): void {
    this.connected = false;
    this.active = false;
    this.connect.mockClear();
    this.disconnect.mockClear();
  }

  accept(): void {
    this.connected = true;
    this.fire('connect');
  }

  /** Network loss or a server restart: socket.io-client keeps the manager active and reconnects on its own. */
  dropConnection(): void {
    this.connected = false;
    this.active = true;
    this.fire('disconnect', 'transport close');
  }

  /** Logout in another tab or the server's session sweep (API.md §3): never retried by socket.io-client. */
  serverDisconnect(): void {
    this.connected = false;
    this.active = false;
    this.fire('disconnect', 'io server disconnect');
  }

  rejectHandshake(code: string): void {
    this.active = false;
    this.fire('connect_error', new Error(code));
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

const fake = vi.hoisted(() => ({ socket: null as FakeSocket | null }));
vi.mock('socket.io-client', () => ({
  io: () => {
    fake.socket ??= new FakeSocket();
    return fake.socket;
  },
}));

function socket(): FakeSocket {
  if (fake.socket === null) {
    throw new Error('The socket was never created.');
  }
  return fake.socket;
}

/** A signed-in tab: the store with the listener, the user in the `getMe` cache, a CSRF token and a live socket. */
async function signedInTab() {
  const store = createAppStore();
  const navigate = vi.fn<(to: string, options?: { replace?: boolean }) => void>();
  startSessionListener(store, navigate);
  await store.dispatch(meApi.util.upsertQueryData('getMe', undefined, { user: MIRA }));
  setCsrfToken('token-of-the-old-session');
  connectRealtime(store);
  socket().accept();
  return { store, navigate };
}

beforeEach(() => {
  fake.socket?.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startSessionListener (F-22, ADR-0012)', () => {
  it('F-22: signs the tab out and goes to the login page with reason=expired', async () => {
    const { store, navigate } = await signedInTab();

    store.dispatch(sessionExpired());

    expect(selectIsAuthenticated(store.getState())).toBe(false);
    expect(getCsrfToken()).toBeNull();
    expect(socket().disconnect).toHaveBeenCalledTimes(1);
    expect(selectRealtimeStatus(store.getState())).toBe('idle');
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(SESSION_EXPIRED_PATH, { replace: true });
    expect(SESSION_EXPIRED_PATH).toBe('/welcome/login?reason=expired');
  });

  it('F-22: resets the whole API state, so no data of the previous user survives', async () => {
    const { store } = await signedInTab();
    expect(Object.keys(store.getState()[baseApi.reducerPath].queries)).not.toHaveLength(0);

    store.dispatch(sessionExpired());

    expect(store.getState()[baseApi.reducerPath].queries).toEqual({});
  });

  it('F-22: handles a second signal for the same expiry as a no-op (message and navigation once)', async () => {
    const { store, navigate } = await signedInTab();

    store.dispatch(sessionExpired());
    store.dispatch(sessionExpired());

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(socket().disconnect).toHaveBeenCalledTimes(1);
  });

  it('F-22: ignores the action for a client that is not signed in', () => {
    const store = createAppStore();
    const navigate = vi.fn();
    startSessionListener(store, navigate);

    store.dispatch(sessionExpired());

    expect(navigate).not.toHaveBeenCalled();
  });

  it('stops after its unsubscribe function ran', async () => {
    const store = createAppStore();
    const navigate = vi.fn();
    const stop = startSessionListener(store, navigate);
    await store.dispatch(meApi.util.upsertQueryData('getMe', undefined, { user: MIRA }));

    stop();
    store.dispatch(sessionExpired());

    expect(navigate).not.toHaveBeenCalled();
    expect(selectIsAuthenticated(store.getState())).toBe(true);
  });
});

describe('the signals that lead to it', () => {
  it('F-22: a 401 on a signed-in request expires the session once', async () => {
    server.use(http.get(apiUrl('/presence'), () => problemResponse(401, 'unauthorized')));
    const probeApi = baseApi.injectEndpoints({
      endpoints: (build) => ({ sessionProbe: build.query<unknown, undefined>({ query: () => '/presence' }) }),
    });
    const { store, navigate } = await signedInTab();

    await store.dispatch(probeApi.endpoints.sessionProbe.initiate(undefined));

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(SESSION_EXPIRED_PATH, { replace: true });
  });

  it('F-22: a 401 from GET /api/me is a visitor, never an expiry', async () => {
    server.use(http.get(apiUrl('/me'), () => problemResponse(401, 'unauthorized')));
    const { store, navigate } = await signedInTab();

    await store.dispatch(meApi.endpoints.getMe.initiate(undefined, { forceRefetch: true }));

    expect(navigate).not.toHaveBeenCalled();
  });

  it('F-22: a server-side socket disconnect (session swept or logged out elsewhere) expires the session', async () => {
    const { store, navigate } = await signedInTab();

    socket().serverDisconnect();

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(SESSION_EXPIRED_PATH, { replace: true });
    expect(selectIsAuthenticated(store.getState())).toBe(false);
  });

  it('F-22: a reconnect refused as unauthorized expires the session', async () => {
    const { navigate } = await signedInTab();
    socket().dropConnection();

    socket().rejectHandshake('unauthorized');

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(SESSION_EXPIRED_PATH, { replace: true });
  });

  it('F-22: a dropped connection is not an expiry; the tab stays signed in while it reconnects', async () => {
    const { store, navigate } = await signedInTab();

    socket().dropConnection();

    expect(navigate).not.toHaveBeenCalled();
    expect(selectIsAuthenticated(store.getState())).toBe(true);
    expect(selectRealtimeStatus(store.getState())).toBe('reconnecting');
  });

  it('F-22: a reconnect refused as rate-limited is not an expiry; the client tries again later', async () => {
    vi.useFakeTimers();
    const { store, navigate } = await signedInTab();
    socket().dropConnection();

    socket().rejectHandshake('rate-limited');
    vi.advanceTimersByTime(HANDSHAKE_RETRY_MS);

    expect(navigate).not.toHaveBeenCalled();
    expect(selectIsAuthenticated(store.getState())).toBe(true);
    // Once by `signedInTab`, once by the retry.
    expect(socket().connect).toHaveBeenCalledTimes(2);
  });

  it('F-22: an expiry while a handshake retry is pending cancels the retry', async () => {
    vi.useFakeTimers();
    const { store, navigate } = await signedInTab();
    socket().dropConnection();
    socket().rejectHandshake('too-many-connections');

    store.dispatch(sessionExpired());
    vi.advanceTimersByTime(HANDSHAKE_RETRY_MS * 2);

    expect(navigate).toHaveBeenCalledTimes(1);
    // Only the connect of `signedInTab`: the old session never tries to open a socket again.
    expect(socket().connect).toHaveBeenCalledTimes(1);
    expect(selectRealtimeStatus(store.getState())).toBe('idle');
  });
});
