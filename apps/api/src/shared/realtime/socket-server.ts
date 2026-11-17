import type { Server as HttpServer } from 'node:http';

import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { Server } from 'socket.io';

import type { SocketEventLimiter } from './event-limiter.js';
import { rooms } from './rooms.js';
import { MAX_SOCKETS_PER_USER, authenticate, handshakeLimit, originCheck, socketCap } from './socket-auth.js';
import type { AppServer, AppSocket, SocketRegistrar, UserSummaryLoader } from './types.js';

/** Proxied by nginx and the Vite dev server under this path (ADR-0008). */
export const SOCKET_PATH = '/socket.io';
/** Largest accepted socket.io message (B-48): a chat message is at most 1,000 characters. */
export const SOCKET_MAX_MESSAGE_BYTES = 16_384;

export interface SocketServerOptions {
  /** `CORS_ORIGINS`: the exact browser origins allowed to open a socket (ADR-0005). */
  allowedOrigins: readonly string[];
}

/**
 * The typed socket.io server, **not yet attached** (API.md §3, ADR-0008). `container.ts` creates it so the publisher
 * and the session guard can be built around it before the HTTP server exists; `attachSocketServer` binds it later.
 *
 * WebSocket transport only, which makes the strict `Origin` rule possible (browsers always send `Origin` on a
 * WebSocket handshake). No client bundle is served (B-134), no connection state recovery (history is resynced over
 * HTTP), and messages above 16 KB close the connection (B-48).
 */
export function createSocketServer({ allowedOrigins }: SocketServerOptions): AppServer {
  return new Server({
    path: SOCKET_PATH,
    transports: ['websocket'],
    serveClient: false,
    maxHttpBufferSize: SOCKET_MAX_MESSAGE_BYTES,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    allowRequest: originCheck(allowedOrigins),
  });
}

export interface SocketHandlersOptions {
  /** `limits.socketHandshake` in Redis under the name `ws-handshake`. */
  handshakeLimiter: SocketEventLimiter;
  /** `TRUST_PROXY`, so the handshake limiter keys on the client and not on nginx. */
  trustedHops: number;
  loadUser: UserSummaryLoader;
  /** Feature registrars in call order; presence must come first (ADR-0008). */
  registrars: readonly SocketRegistrar[];
  logger: Pick<Logger, 'debug' | 'error'>;
  /** Defaults to `MAX_SOCKETS_PER_USER` (10). */
  maxSocketsPerUser?: number;
}

/**
 * The handshake chain (`handshakeLimit` -> `authenticate` -> `socketCap`, socket-auth.ts) and the registrar loop.
 * Every accepted socket is in `rooms.user(id)` (joined by the cap), `rooms.session(sid)` and `rooms.chat` before the
 * first registrar runs. A registrar that throws is a bug: the socket is closed rather than left half-registered.
 * Call once per server, before it accepts connections.
 */
export function registerSocketHandlers(
  io: AppServer,
  {
    handshakeLimiter,
    trustedHops,
    loadUser,
    registrars,
    logger,
    maxSocketsPerUser = MAX_SOCKETS_PER_USER,
  }: SocketHandlersOptions,
): void {
  io.use(handshakeLimit({ limiter: handshakeLimiter, trustedHops, logger }));
  io.use(authenticate({ loadUser, logger }));
  io.use(socketCap(maxSocketsPerUser));

  io.on('connection', (socket: AppSocket) => {
    const userId = socket.data.user.id;
    void socket.join([rooms.session(socket.data.sessionId), rooms.chat]);
    logger.debug({ socketId: socket.id, userId }, 'socket connected');
    socket.on('disconnect', (reason) => {
      logger.debug({ socketId: socket.id, userId, reason }, 'socket disconnected');
    });

    for (const register of registrars) {
      try {
        register(socket, io);
      } catch (error) {
        logger.error({ err: error, socketId: socket.id, userId }, 'socket registrar failed');
        socket.disconnect(true);
        return;
      }
    }
  });
}

/**
 * Binds io to the HTTP server (`server.ts`, and the test app on an ephemeral port) and runs the same express-session
 * middleware as the HTTP app on every upgrade request, so `authenticate` sees `req.session` (ADR-0005). engine.io
 * only exists after `attach`, which is why the session middleware is added here and not in `createSocketServer`.
 *
 * Shutdown: `await io.close()` closes every socket, the engine and this HTTP server (socket.io closes the server it
 * is attached to), so it replaces a separate `httpServer.close()`.
 */
export function attachSocketServer(io: AppServer, httpServer: HttpServer, sessionMiddleware: RequestHandler): void {
  io.attach(httpServer);
  io.engine.use(sessionMiddleware);
}
