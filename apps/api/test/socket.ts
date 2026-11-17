import type { ClientToServerEvents, ServerToClientEvents } from '@app/shared';
import { io, type Socket } from 'socket.io-client';

import { SOCKET_PATH } from '../src/shared/realtime/socket-server.js';
import type { TestAgent } from './http.js';
import { TEST_ORIGIN } from './test-app.js';

/**
 * socket.io-client helpers for integration tests (BUILD-ORDER 1b "Test helpers", ADR-0016; frozen after Phase 1b).
 * Wall, chat and presence socket tests and `test/realtime.int.test.ts` use them.
 */

/** A client socket typed with the shared event maps, so emits and payloads are checked like in the web app. */
export type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type ServerEvent = keyof ServerToClientEvents;
/** The (single) payload of a server -> client event. */
export type EventPayload<E extends ServerEvent> = Parameters<ServerToClientEvents[E]>[0];

/** How long `connectAs` and `waitFor` wait by default before failing with a message that names what was missing. */
export const SOCKET_WAIT_MS = 5_000;

export interface ConnectOptions {
  /** The test app's `baseUrl`; passing the `TestApp` itself works too. */
  baseUrl: string;
  /** The `Origin` header: defaults to the allow-listed `TEST_ORIGIN`; `null` sends none (B-07, B-38). */
  origin?: string | null;
  timeoutMs?: number;
}

/**
 * The agent's cookies for the socket path. Cookies ignore ports, so the cookies a `request.agent(testApp.app)` agent
 * received on supertest's ephemeral servers (all on 127.0.0.1) are valid at `baseUrl`. HttpOnly cookies included.
 */
function cookieHeader(agent: TestAgent): string {
  return agent.jar
    .getCookies({ domain: '127.0.0.1', path: `${SOCKET_PATH}/`, secure: false, script: false })
    .toValueString();
}

/**
 * Opens a WebSocket-only socket.io connection as the agent's session and resolves once the server accepted it.
 * Rejects with the `connect_error` (its `message` is the handshake code: `unauthorized`, `rate-limited`,
 * `too-many-connections`, or engine.io's error for a refused origin), after closing the client. Reconnection is off,
 * so a rejected or server-closed socket stays closed and nothing retries after the test.
 *
 * An agent without a session (fresh `request.agent(app)`) connects anonymously, which the server rejects.
 */
export function connectAs(
  agent: TestAgent,
  { baseUrl, origin = TEST_ORIGIN, timeoutMs = SOCKET_WAIT_MS }: ConnectOptions,
): Promise<TestSocket> {
  const cookie = cookieHeader(agent);
  const socket: TestSocket = io(baseUrl, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    extraHeaders: { ...(origin === null ? {} : { origin }), ...(cookie ? { cookie } : {}) },
    reconnection: false,
    forceNew: true,
    timeout: timeoutMs,
  });

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    };
    const onConnect = (): void => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error): void => {
      cleanup();
      socket.close();
      reject(error);
    };
    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
  });
}

export interface WaitOptions<E extends ServerEvent> {
  /** Only a payload for which this returns true resolves the wait (e.g. the test's own chat message). */
  filter?: (payload: EventPayload<E>) => boolean;
  timeoutMs?: number;
}

/**
 * Resolves with the payload of the next `event` the socket receives (that passes `filter`), or rejects after
 * `timeoutMs` with an error naming the event. Subscribe **before** triggering the event:
 * `const created = waitFor(socket, 'wall:post-created'); await agent.post(...); await created;`.
 */
export function waitFor<E extends ServerEvent>(
  socket: TestSocket,
  event: E,
  { filter, timeoutMs = SOCKET_WAIT_MS }: WaitOptions<E> = {},
): Promise<EventPayload<E>> {
  return new Promise((resolve, reject) => {
    const listener = (name: string, ...args: unknown[]): void => {
      if (name !== event) return;
      // The server emits through the same typed `ServerToClientEvents`, so the payload has the event's type.
      const payload = args[0] as EventPayload<E>;
      if (filter && !filter(payload)) return;
      clearTimeout(timer);
      socket.offAny(listener);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.offAny(listener);
      reject(new Error(`waitFor: no '${event}' within ${String(timeoutMs)} ms`));
    }, timeoutMs);
    socket.onAny(listener);
  });
}

/** Resolves with the disconnect reason (e.g. `io server disconnect` after a session sweep or logout). */
export function waitForDisconnect(
  socket: TestSocket,
  { timeoutMs = SOCKET_WAIT_MS }: { timeoutMs?: number } = {},
): Promise<Socket.DisconnectReason> {
  return new Promise((resolve, reject) => {
    if (socket.disconnected) {
      reject(new Error('waitForDisconnect: the socket is not connected'));
      return;
    }
    const onDisconnect = (reason: Socket.DisconnectReason): void => {
      clearTimeout(timer);
      resolve(reason);
    };
    const timer = setTimeout(() => {
      socket.off('disconnect', onDisconnect);
      reject(new Error(`waitForDisconnect: still connected after ${String(timeoutMs)} ms`));
    }, timeoutMs);
    socket.once('disconnect', onDisconnect);
  });
}

/**
 * Records every payload of `event` from now on into the returned (live) array, for assertions that something was
 * **not** received: trigger the event for another socket, `await waitFor` it there, then expect this array to be
 * empty, so the check is ordered by a real delivery instead of a sleep.
 */
export function recordEvents<E extends ServerEvent>(socket: TestSocket, event: E): EventPayload<E>[] {
  const received: EventPayload<E>[] = [];
  socket.onAny((name: string, ...args: unknown[]) => {
    // Same typing argument as in `waitFor`.
    if (name === event) received.push(args[0] as EventPayload<E>);
  });
  return received;
}
