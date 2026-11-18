import type { Page, WebSocket } from '@playwright/test';

import { isRecord } from './api.js';

/** socket.io's path behind nginx (ADR-0008). */
export const SOCKET_PATH = '/socket.io/';

/** How long a page may take to finish the Socket.IO handshake after it loaded. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** The accepted handshake: the socket's URL and the server's `40{"sid":…}` frame. */
export interface SocketHandshake {
  url: string;
  frame: string;
}

function isSocketIo(socket: WebSocket): boolean {
  return new URL(socket.url()).pathname === SOCKET_PATH;
}

function frameText(payload: string | Buffer): string {
  return typeof payload === 'string' ? payload : payload.toString('utf8');
}

/**
 * The socket id of a Socket.IO CONNECT packet for the default namespace (`40{"sid":"…"}`), or null for any other
 * frame. The server sends it after the handshake middleware accepted the session and joined the user's rooms.
 */
export function connectPacketSocketId(payload: string | Buffer): string | null {
  const frame = frameText(payload);
  if (!frame.startsWith('40{')) return null;
  const packet: unknown = JSON.parse(frame.slice(2));
  return isRecord(packet) && typeof packet['sid'] === 'string' ? packet['sid'] : null;
}

/**
 * Resolves once the page's socket.io connection through nginx was accepted: the server answered the namespace
 * CONNECT with `40{"sid":…}`, so the user's rooms are joined and, for presence, the user counts as online. Rejects on
 * a refused handshake (`44…`, e.g. `unauthorized`), when nothing arrives in time, or when the page closes first.
 * Start it before the navigation that opens the socket.
 *
 * The returned promise is already marked as handled: a test that fails before it awaits the handshake ends with its
 * own error, not with an unhandled rejection from this timer that would surface in whatever test the worker runs
 * next. Awaiting it still rejects as usual.
 */
export function socketHandshake(page: Page): Promise<SocketHandshake> {
  const handshake = new Promise<SocketHandshake>((resolve, reject) => {
    const detachers: (() => void)[] = [];
    const settle = (finish: () => void): void => {
      clearTimeout(timer);
      for (const detach of detachers) detach();
      finish();
    };
    const timer = setTimeout(() => {
      settle(() => {
        reject(new Error(`no Socket.IO handshake within ${String(HANDSHAKE_TIMEOUT_MS)} ms`));
      });
    }, HANDSHAKE_TIMEOUT_MS);

    const onClose = (): void => {
      settle(() => {
        reject(new Error('the page closed before its Socket.IO handshake was answered'));
      });
    };
    const onSocket = (socket: WebSocket): void => {
      if (!isSocketIo(socket)) return;
      const onFrame = ({ payload }: { payload: string | Buffer }): void => {
        const frame = frameText(payload);
        if (frame.startsWith('40')) {
          settle(() => {
            resolve({ url: socket.url(), frame });
          });
        } else if (frame.startsWith('44')) {
          settle(() => {
            reject(new Error(`the Socket.IO handshake was refused: ${frame}`));
          });
        }
      };
      socket.on('framereceived', onFrame);
      detachers.push(() => socket.off('framereceived', onFrame));
    };

    page.on('websocket', onSocket);
    page.once('close', onClose);
    detachers.push(
      () => page.off('websocket', onSocket),
      () => page.off('close', onClose),
    );
  });
  handshake.catch(() => undefined);
  return handshake;
}

/** One WebSocket the page opened to `/socket.io/`, as seen on the wire. */
export interface ObservedSocket {
  url: string;
  /**
   * Socket ids from the server's CONNECT packets: one entry per time the socket reached `connected`. A reconnect on
   * the same WebSocket would add a second id.
   */
  connectedIds: string[];
  closed: boolean;
}

/**
 * Records every Socket.IO WebSocket the page opens from now on. The app has no visible "connected" indicator (the
 * banner only speaks up while reconnecting, F-107), so the wire is the proof. Attach it before the first `goto`.
 */
export function observeRealtimeSockets(page: Page): ObservedSocket[] {
  const sockets: ObservedSocket[] = [];
  page.on('websocket', (socket) => {
    if (!isSocketIo(socket)) return;
    const observed: ObservedSocket = { url: socket.url(), connectedIds: [], closed: false };
    sockets.push(observed);
    socket.on('framereceived', ({ payload }) => {
      const id = connectPacketSocketId(payload);
      if (id !== null) observed.connectedIds.push(id);
    });
    socket.on('close', () => {
      observed.closed = true;
    });
  });
  return sockets;
}
