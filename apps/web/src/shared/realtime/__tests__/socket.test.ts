import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

/** Just enough of socket.io-client's `Socket` to drive the lifecycle: `connected`, `active`, events. */
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
    const wasConnected = this.connected;
    this.connected = false;
    this.active = false;
    if (wasConnected) {
      this.fire('disconnect', 'io client disconnect');
    }
    return this;
  });

  listenerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0;
  }

  /** The server accepted the handshake. */
  accept(): void {
    this.connected = true;
    this.fire('connect');
  }

  /** The connection dropped; the manager keeps retrying (`active` stays true). */
  drop(reason: string): void {
    this.connected = false;
    this.fire('disconnect', reason);
  }

  /** The server closed the socket (logout elsewhere, session sweep); never retried. */
  serverDisconnect(): void {
    this.connected = false;
    this.active = false;
    this.fire('disconnect', 'io server disconnect');
  }

  /** A server middleware refused the handshake (`next(new Error(code))`); never retried. */
  rejectHandshake(code: string): void {
    this.active = false;
    this.fire('connect_error', new Error(code));
  }

  /** The server was unreachable; the manager retries with backoff. */
  transportError(): void {
    this.fire('connect_error', new Error('websocket error'));
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

const ioMock = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: ioMock }));

let fake: FakeSocket;

/** Fresh module instances per test: the socket module holds the tab's single socket. */
async function load() {
  const socketModule = await import('../socket');
  const fixtures = await import('../../api/__tests__/fixtures');
  const { sessionExpired } = await import('../../session/session-events');
  const { selectRealtimeStatus } = await import('../realtimeSlice');
  const testStore = fixtures.createTestStore();
  const status = () => selectRealtimeStatus(testStore.store.getState());
  const expiries = () => testStore.actionsOfType(sessionExpired.type).length;
  const signIn = () => fixtures.signInAs(testStore.store);
  return { ...socketModule, ...testStore, status, expiries, signIn };
}

beforeEach(() => {
  vi.resetModules();
  fake = new FakeSocket();
  ioMock.mockReset();
  ioMock.mockImplementation(() => fake);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getSocket', () => {
  it('creates one WebSocket-only socket on /socket.io that waits for connectRealtime (ADR-0005, ADR-0008)', async () => {
    const { getSocket } = await load();

    const first = getSocket();
    const second = getSocket();

    expect(first).toBe(second);
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(ioMock).toHaveBeenCalledWith({ path: '/socket.io', transports: ['websocket'], autoConnect: false });
    expect(fake.connect).not.toHaveBeenCalled();
  });
});

describe('connectRealtime', () => {
  it('reports connecting, then connected', async () => {
    const { connectRealtime, store, status, actionsOfType } = await load();

    connectRealtime(store);
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(status()).toBe('connecting');

    fake.accept();
    expect(status()).toBe('connected');
    expect(actionsOfType('realtime/connected')).toEqual([{ type: 'realtime/connected', payload: { resumed: false } }]);
  });

  it('never opens a second connection while connected or connecting (F-03, B-79)', async () => {
    const { connectRealtime, store } = await load();

    connectRealtime(store);
    connectRealtime(store);
    fake.accept();
    connectRealtime(store);

    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount('connect')).toBe(1);
    expect(fake.listenerCount('disconnect')).toBe(1);
    expect(fake.listenerCount('connect_error')).toBe(1);
  });

  it('shows reconnecting after a dropped connection and reports the next connect as resumed (F-107)', async () => {
    const { connectRealtime, store, status, actionsOfType, expiries, signIn } = await load();
    await signIn();
    connectRealtime(store);
    fake.accept();

    fake.drop('transport close');
    expect(status()).toBe('reconnecting');

    fake.accept();
    expect(status()).toBe('connected');
    expect(actionsOfType('realtime/connected').at(-1)).toEqual({
      type: 'realtime/connected',
      payload: { resumed: true },
    });
    expect(expiries()).toBe(0);
  });

  it('shows reconnecting while the server is unreachable, leaving the retries to socket.io-client', async () => {
    vi.useFakeTimers();
    const { connectRealtime, store, status } = await load();
    connectRealtime(store);

    fake.transportError();
    expect(status()).toBe('reconnecting');
    vi.advanceTimersByTime(60_000);
    expect(fake.connect).toHaveBeenCalledTimes(1);

    fake.accept();
    expect(status()).toBe('connected');
  });
});

describe('session signals (ADR-0012)', () => {
  it('a server-side disconnect of a signed-in user is a session expiry, once', async () => {
    const { connectRealtime, store, status, expiries, signIn } = await load();
    await signIn();
    connectRealtime(store);
    fake.accept();

    fake.serverDisconnect();

    expect(expiries()).toBe(1);
    expect(status()).toBe('idle');
  });

  it('a server-side disconnect without a signed-in user only goes idle', async () => {
    const { connectRealtime, store, status, expiries } = await load();
    connectRealtime(store);
    fake.accept();

    fake.serverDisconnect();

    expect(expiries()).toBe(0);
    expect(status()).toBe('idle');
  });

  it('a handshake refused as unauthorized expires a signed-in session', async () => {
    const { connectRealtime, store, status, expiries, signIn } = await load();
    await signIn();
    connectRealtime(store);

    fake.rejectHandshake('unauthorized');

    expect(expiries()).toBe(1);
    expect(status()).toBe('idle');
  });

  it('a handshake refused as unauthorized for a visitor only goes idle', async () => {
    const { connectRealtime, store, status, expiries } = await load();
    connectRealtime(store);

    fake.rejectHandshake('unauthorized');

    expect(expiries()).toBe(0);
    expect(status()).toBe('idle');
  });

  it.each(['rate-limited', 'too-many-connections', 'internal'])(
    'a handshake refused with %s keeps "Reconnecting…" and retries after 30 s',
    async (code) => {
      vi.useFakeTimers();
      const { connectRealtime, store, status, expiries, signIn, HANDSHAKE_RETRY_MS } = await load();
      await signIn();
      connectRealtime(store);

      fake.rejectHandshake(code);
      expect(status()).toBe('reconnecting');
      expect(expiries()).toBe(0);

      // Navigation calls connectRealtime again; it must not cut the wait short.
      connectRealtime(store);
      vi.advanceTimersByTime(HANDSHAKE_RETRY_MS - 1);
      expect(fake.connect).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(fake.connect).toHaveBeenCalledTimes(2);

      fake.accept();
      expect(status()).toBe('connected');
    },
  );
});

describe('disconnectRealtime', () => {
  it('closes the socket and goes idle without a session expiry (logout)', async () => {
    const { connectRealtime, disconnectRealtime, store, status, expiries, signIn } = await load();
    await signIn();
    connectRealtime(store);
    fake.accept();

    disconnectRealtime();

    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(status()).toBe('idle');
    expect(expiries()).toBe(0);
  });

  it('cancels a pending handshake retry', async () => {
    vi.useFakeTimers();
    const { connectRealtime, disconnectRealtime, store, status } = await load();
    connectRealtime(store);
    fake.rejectHandshake('rate-limited');

    disconnectRealtime();
    vi.advanceTimersByTime(60_000);

    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(status()).toBe('idle');
  });

  it('does nothing before a socket exists', async () => {
    const { disconnectRealtime, status } = await load();
    disconnectRealtime();
    expect(ioMock).not.toHaveBeenCalled();
    expect(status()).toBe('idle');
  });

  it('can connect the same socket again after the next sign-in', async () => {
    const { connectRealtime, disconnectRealtime, store, status, getSocket } = await load();
    const socket = connectRealtime(store);
    fake.accept();
    disconnectRealtime();

    expect(connectRealtime(store)).toBe(socket);
    expect(getSocket()).toBe(socket);
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(status()).toBe('connecting');
  });
});

describe('realtime slice', () => {
  it('goes idle on sessionExpired, so the banner never shows on the way to the login page', async () => {
    const { connectRealtime, store, status } = await load();
    const { sessionExpired } = await import('../../session/session-events');
    connectRealtime(store);
    fake.accept();
    fake.drop('ping timeout');
    expect(status()).toBe('reconnecting');

    store.dispatch(sessionExpired());

    expect(status()).toBe('idle');
  });
});
