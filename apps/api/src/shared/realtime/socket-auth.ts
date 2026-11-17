import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

import { Id } from '@app/shared';
import type { Logger } from 'pino';
import type { ExtendedError } from 'socket.io';
import { z } from 'zod';

import { clientIpKey } from '../security/security.js';
import type { SocketEventLimiter } from './event-limiter.js';
import { rooms } from './rooms.js';
import type { AppSocket, HandshakeErrorCode, UserSummaryLoader } from './types.js';

/**
 * The socket handshake (ADR-0005, API.md §3, F-111, B-07, B-38). Order at runtime (engine.io 6.6):
 *
 * 1. The express-session middleware on `io.engine` puts the session on the upgrade request (`socket-server.ts`).
 *    engine.io runs `io.engine.use` middlewares before `allowRequest`, so a validly signed session cookie is read
 *    from Redis even when the origin is refused next; nothing connects either way.
 * 2. `originCheck` as engine.io `allowRequest`: a missing or non-allow-listed `Origin` is refused before the upgrade
 *    (CORS does not protect WebSockets; with the WebSocket-only transport browsers always send `Origin`).
 * 3. `io.use`: `handshakeLimit` -> `authenticate` -> `socketCap`, each rejecting with a `HandshakeErrorCode` as the
 *    error message, which socket.io-client reports as `connect_error`.
 */

type SocketMiddleware = (socket: AppSocket, next: (err?: ExtendedError) => void) => void;

/** ADR-0005: at most 10 open sockets per user. */
export const MAX_SOCKETS_PER_USER = 10;

function handshakeError(code: HandshakeErrorCode, data?: Record<string, unknown>): ExtendedError {
  const error: ExtendedError = new Error(code);
  if (data) error.data = data;
  return error;
}

/**
 * engine.io `allowRequest`: the `Origin` header must be present and exactly one of `CORS_ORIGINS` (already normalised
 * to bare origins by the env schema). The message goes into the 400 body engine.io answers; it names no origin.
 */
export function originCheck(
  allowedOrigins: readonly string[],
): (req: Pick<IncomingMessage, 'headers'>, callback: (err: string | null, success: boolean) => void) => void {
  const allowed = new Set(allowedOrigins);
  return (req, callback) => {
    const { origin } = req.headers;
    if (origin !== undefined && allowed.has(origin)) callback(null, true);
    else callback('origin not allowed', false);
  };
}

/**
 * The client address of a raw upgrade request with Express' numeric `trust proxy` semantics (`TRUST_PROXY` hops):
 * walk from the socket address back through `X-Forwarded-For` (right to left) for as many hops as are trusted.
 * With 0 hops the header is ignored entirely, so a client cannot spoof its address; behind one proxy (nginx appends
 * the peer it saw) the right-most entry is used. Equivalent to `req.ip` in the HTTP app.
 */
export interface UpgradeRequestAddress {
  readonly headers: IncomingHttpHeaders;
  readonly socket: { readonly remoteAddress?: string | undefined };
}

export function clientAddress(req: UpgradeRequestAddress, trustedHops: number): string {
  const peer = req.socket.remoteAddress ?? '';
  if (trustedHops <= 0) return peer;
  const header = req.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .reverse();
  const chain = [peer, ...forwarded];
  return chain[Math.min(trustedHops, chain.length - 1)] ?? peer;
}

export interface HandshakeLimitOptions {
  /** 30 per minute per IP in production (`limits.socketHandshake`), Redis name `ws-handshake`. */
  limiter: SocketEventLimiter;
  /** `TRUST_PROXY`: the number of reverse proxies in front of the API. */
  trustedHops: number;
  logger: Pick<Logger, 'error'>;
}

/** Step 3.1: handshakes per client IP (IPv6 per /56, conventions §8) -> `rate-limited` with `retryAfterMs`. */
export function handshakeLimit({ limiter, trustedHops, logger }: HandshakeLimitOptions): SocketMiddleware {
  return (socket, next) => {
    const key = clientIpKey({ ip: clientAddress(socket.request, trustedHops) });
    limiter.consume(key).then(
      (decision) => {
        next(decision.allowed ? undefined : handshakeError('rate-limited', { retryAfterMs: decision.retryAfterMs }));
      },
      (error: unknown) => {
        // Fail closed like the HTTP limiters: an unreachable Redis must not switch the limit off.
        logger.error({ err: error, socketId: socket.id }, 'socket handshake limiter failed');
        next(handshakeError('internal'));
      },
    );
  };
}

/**
 * The part of express-session's `req.session` the handshake reads. Parsed instead of trusted: `socket.request` is a
 * plain `IncomingMessage` in the types, and an upgrade that skipped the session middleware must not pass as signed in.
 */
const HandshakeSession = z.object({ id: z.string().min(1), userId: Id.optional() });

function sessionOf(req: IncomingMessage): z.infer<typeof HandshakeSession> | null {
  const parsed = HandshakeSession.safeParse(Reflect.get(req, 'session'));
  return parsed.success ? parsed.data : null;
}

export interface AuthenticateOptions {
  loadUser: UserSummaryLoader;
  logger: Pick<Logger, 'error'>;
}

/**
 * Step 3.2: no signed-in session -> `unauthorized` (B-38). Loads the `UserSummary` once into `socket.data.user`
 * (B-75) and stores the session id in `socket.data.sessionId`. A user that no longer exists is `unauthorized` too.
 */
export function authenticate({ loadUser, logger }: AuthenticateOptions): SocketMiddleware {
  return (socket, next) => {
    const session = sessionOf(socket.request);
    if (session?.userId === undefined) {
      next(handshakeError('unauthorized'));
      return;
    }
    const { id: sessionId, userId } = session;
    loadUser(userId).then(
      (user) => {
        if (user?.id !== userId) {
          next(handshakeError('unauthorized'));
          return;
        }
        socket.data.user = user;
        socket.data.sessionId = sessionId;
        next();
      },
      (error: unknown) => {
        logger.error({ err: error, socketId: socket.id, userId }, 'socket handshake user lookup failed');
        next(handshakeError('internal'));
      },
    );
  };
}

/**
 * Step 3.3, the last handshake step: at most `max` open sockets per user (`too-many-connections`, ADR-0005).
 * Counts the members of `rooms.user(id)` and joins it in the same synchronous step, so concurrent handshakes of one
 * user cannot all pass the check before any of them is counted. A socket that fails to connect afterwards (client
 * gone) leaves all rooms in socket.io's cleanup. Single instance: with a Redis adapter this becomes `fetchSockets()`.
 */
export function socketCap(max: number = MAX_SOCKETS_PER_USER): SocketMiddleware {
  return (socket, next) => {
    const room = rooms.user(socket.data.user.id);
    const open = socket.nsp.adapter.rooms.get(room)?.size ?? 0;
    if (open >= max) {
      next(handshakeError('too-many-connections'));
      return;
    }
    void socket.join(room);
    next();
  };
}
