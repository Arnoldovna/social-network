import { HandshakeErrorCode } from '@app/shared';
import type { ClientToServerEvents, ServerToClientEvents } from '@app/shared';
import type { Dispatch } from '@reduxjs/toolkit';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';

import type { ApiState } from '../api/baseApi';
import { selectIsAuthenticated } from '../api/me.api';
import { sessionExpired } from '../session/session-events';
import { realtimeActions } from './realtimeSlice';

/** The typed client socket: events and payloads from the shared contract (API.md §3). */
export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** After `rate-limited`, `too-many-connections` or `internal` the client waits this long before it tries again. */
export const HANDSHAKE_RETRY_MS = 30_000;

/** What the socket lifecycle needs from the store (the app passes its store; tests pass a plain one). */
export interface RealtimeStore {
  dispatch: Dispatch;
  getState: () => unknown;
}

let socket: AppSocket | null = null;
let store: RealtimeStore | null = null;
let lifecycleBound = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Set while the signed-in client has no live socket although it should: the connection dropped, or the first attempt
 * after sign-in failed (server unreachable, handshake to retry). The next `connect` is then reported as resumed, so
 * the caches resync (F-107): the pages loaded their data over HTTP meanwhile and missed every event in between, also
 * when the socket had never connected before.
 */
let interrupted = false;

/**
 * The one socket of this tab (ADR-0008), created on first use and never replaced: features attach their event
 * handlers in `onCacheEntryAdded` whether or not it is connected yet, and the handlers survive reconnects.
 * WebSocket transport only, so the server's strict Origin rule holds (ADR-0005); same origin, so the session cookie
 * goes with the handshake. It does not connect until `connectRealtime` runs after `getMe` succeeded.
 */
export function getSocket(): AppSocket {
  socket ??= io({ path: '/socket.io', transports: ['websocket'], autoConnect: false });
  return socket;
}

function wasAuthenticated(): boolean {
  // The store always mounts `baseApi.reducer` (app/store.ts); `getState` is typed `unknown` to keep this decoupled.
  return store !== null && selectIsAuthenticated(store.getState() as ApiState);
}

function clearRetry(): void {
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
}

/** The signed-in client lost (or never got) its live socket; the next `connect` resyncs the caches (F-107). */
function markInterrupted(): void {
  interrupted = true;
  store?.dispatch(realtimeActions.reconnecting());
}

/** The server rejected the session: expiry for a signed-in client, otherwise simply no socket (ADR-0012). */
function endForLostSession(): void {
  interrupted = false;
  store?.dispatch(wasAuthenticated() ? sessionExpired() : realtimeActions.disconnected());
}

function handleConnect(): void {
  clearRetry();
  const resumed = interrupted;
  interrupted = false;
  store?.dispatch(realtimeActions.connected({ resumed }));
}

function handleDisconnect(reason: Socket.DisconnectReason): void {
  if (reason === 'io client disconnect') {
    // Our own `disconnectRealtime()`, which reports `idle` itself.
    return;
  }
  if (reason === 'io server disconnect') {
    // Logout elsewhere, expired or destroyed session (the server's sweep). socket.io-client never retries this.
    endForLostSession();
    return;
  }
  // Network loss, ping timeout, server restart: socket.io-client reconnects with backoff on its own.
  markInterrupted();
}

function handleConnectError(error: Error): void {
  if (getSocket().active) {
    // A transport failure (server unreachable); the manager keeps retrying with backoff.
    markInterrupted();
    return;
  }
  // The handshake was refused by a server middleware (API.md §3); socket.io-client does not retry those.
  const code = HandshakeErrorCode.safeParse(error.message);
  if (code.success && code.data === 'unauthorized') {
    endForLostSession();
    return;
  }
  // `rate-limited`, `too-many-connections`, `internal`: keep "Reconnecting…" and try again later.
  markInterrupted();
  clearRetry();
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    getSocket().connect();
  }, HANDSHAKE_RETRY_MS);
}

export interface ConnectRealtimeOptions {
  /**
   * The signed-in user had no live socket for a while although the session went on: a logout that closed the socket
   * first and then failed (ADR-0012). Events of that gap are lost, so the next `connect` is reported as resumed and the
   * real-time caches resync (F-107), as after a dropped connection.
   */
  resume?: boolean;
}

/**
 * Connects the tab's socket for a signed-in user and reports its status to the `realtime` slice. Calling it again
 * while the socket is connected, connecting or waiting to retry does nothing, so client-side navigation never opens a
 * second connection (F-03, B-79).
 */
export function connectRealtime(target: RealtimeStore, { resume = false }: ConnectRealtimeOptions = {}): AppSocket {
  store = target;
  const current = getSocket();
  if (!lifecycleBound) {
    current.on('connect', handleConnect);
    current.on('disconnect', handleDisconnect);
    current.on('connect_error', handleConnectError);
    lifecycleBound = true;
  }
  if (current.connected || current.active || retryTimer !== undefined) {
    return current;
  }
  interrupted = resume;
  target.dispatch(realtimeActions.connecting());
  current.connect();
  return current;
}

/**
 * Closes the socket on logout (before `POST /auth/logout`, so this tab never sees the server's disconnect) and on
 * session expiry, and cancels a pending retry. The socket object stays, ready for the next sign-in.
 */
export function disconnectRealtime(): void {
  clearRetry();
  interrupted = false;
  if (socket === null) {
    return;
  }
  socket.disconnect();
  store?.dispatch(realtimeActions.disconnected());
}
