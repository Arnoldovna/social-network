import type { Ack, ClientToServerEvents, SocketError, SocketErrorCode } from '@app/shared';
import type { Logger } from 'pino';
import type { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import type { SocketEventLimiter } from './event-limiter.js';
import type { SessionGuard } from './session-guard.js';
import type { AppSocket } from './types.js';

/**
 * Acknowledgements of client -> server events (API.md §3, F-112). Handlers never throw to socket.io: every outcome,
 * including an unexpected error, is an ack `{ ok: true, ... }` or `{ ok: false, error: { code, message } }`.
 */

/** Client-safe default text per code; the web app shows its own copy per code and uses these only as a fallback. */
export const SOCKET_ERROR_MESSAGES: Readonly<Record<SocketErrorCode, string>> = Object.freeze({
  'validation-failed': 'The request is invalid.',
  'rate-limited': 'Too many requests. Try again later.',
  unauthorized: 'Authentication is required.',
  forbidden: 'You are not allowed to do this.',
  'not-found': 'Not found.',
  internal: 'An unexpected error occurred.',
});

export interface AckFailure {
  ok: false;
  error: SocketError;
}

/** `{ ok: true }`, or `{ ok: true, ...data }`. `ok` is set last, so `data` can never turn a success into a failure. */
export function ok(): { ok: true };
export function ok<T extends object>(data: T): { ok: true } & T;
export function ok(data: object = {}): { ok: true } {
  return { ...data, ok: true };
}

/** `{ ok: false, error }` with the code's default message unless a client-safe one is given. */
export function fail(
  code: SocketErrorCode,
  message: string = SOCKET_ERROR_MESSAGES[code],
  retryAfterMs?: number,
): AckFailure {
  return {
    ok: false,
    error: retryAfterMs === undefined ? { code, message } : { code, message, retryAfterMs: Math.ceil(retryAfterMs) },
  };
}

/** HTTP status of an `AppError` -> socket code. Statuses without a socket meaning become `internal`. */
const CODE_BY_STATUS: ReadonlyMap<number, SocketErrorCode> = new Map([
  [400, 'validation-failed'],
  [401, 'unauthorized'],
  [403, 'forbidden'],
  [404, 'not-found'],
  [422, 'validation-failed'],
  [429, 'rate-limited'],
]);

/**
 * Lets socket handlers reuse services that throw `AppError`s (e.g. `NotFoundError` from a shared lookup): a known
 * 4xx keeps its client-safe `detail` as the message; everything else is `internal` with the generic message, so no
 * internal error text reaches a client (F-106). `expected` tells the caller whether the error needs an error log.
 */
export function toSocketFailure(error: unknown): { failure: AckFailure; expected: boolean } {
  if (error instanceof AppError) {
    const code = CODE_BY_STATUS.get(error.status);
    if (code) return { failure: fail(code, error.message), expected: true };
  }
  return { failure: fail('internal'), expected: false };
}

/**
 * The ack a client passed, or a no-op. The client controls the arguments: a missing or non-function ack (an emit
 * without callback, extra arguments) is ignored safely instead of throwing (API.md §3).
 */
export function ackCallback(candidate: unknown): (response: Ack) => void {
  if (typeof candidate !== 'function') return () => undefined;
  return (response) => {
    // socket.io's ack function; calling it with the response object is its whole contract.
    Reflect.apply(candidate, undefined, [response]);
  };
}

type ClientEvent = keyof ClientToServerEvents;

/** The ack type a client -> server event declares in the shared event map, e.g. `Ack<{ message: ChatMessage }>`. */
export type AckOf<E extends ClientEvent> = Parameters<Parameters<ClientToServerEvents[E]>[1]>[0];

export interface ClientEventDefinition<E extends ClientEvent, Schema extends z.ZodType> {
  /** The payload schema from `@app/shared` (`SendChatMessage`, `WallRoomPayload`), F-112. */
  schema: Schema;
  /** Set for mutating events (`chat:send`, `wall:join`): the session is re-checked before anything else. */
  sessionGuard?: SessionGuard;
  /** Keyed by the socket's user id; a rejection is `rate-limited` with `retryAfterMs` (F-84). */
  limiter?: SocketEventLimiter;
  logger: Pick<Logger, 'debug' | 'error'>;
  /** The feature logic. May throw `AppError`s (mapped by `toSocketFailure`); must not emit the ack itself. */
  handle(input: z.output<Schema>, socket: AppSocket): Promise<AckOf<E>>;
}

/**
 * Registers a client -> server event with the pipeline every event follows (ADR-0008, OVERVIEW §3):
 * session-alive guard -> Zod `safeParse` -> limiter -> `handle` -> ack. Each step that fails answers through the ack
 * and stops; nothing is ever thrown to socket.io (an async listener's rejection would be unhandled). A dead session
 * is acked `unauthorized` and the socket is then disconnected, so the client turns it into `sessionExpired`.
 *
 * Logs one `debug` line per event `{ event, socketId, userId, ok, code }`; never the payload (message text, F-113).
 */
export function onClientEvent<E extends ClientEvent, Schema extends z.ZodType>(
  socket: AppSocket,
  event: E,
  definition: ClientEventDefinition<E, Schema>,
): void {
  const { schema, sessionGuard, limiter, logger } = definition;
  const userId = socket.data.user.id;

  async function respond(payload: unknown): Promise<{ response: Ack; disconnect: boolean }> {
    if (sessionGuard && !(await sessionGuard.isAlive(socket))) {
      return { response: fail('unauthorized'), disconnect: true };
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      return { response: fail('validation-failed', issue?.message), disconnect: false };
    }
    if (limiter) {
      const decision = await limiter.consume(String(userId));
      if (!decision.allowed) {
        return { response: fail('rate-limited', undefined, decision.retryAfterMs), disconnect: false };
      }
    }
    return { response: await definition.handle(parsed.data, socket), disconnect: false };
  }

  async function run(payload: unknown, reply: (response: Ack) => void): Promise<void> {
    let outcome: { response: Ack; disconnect: boolean };
    try {
      outcome = await respond(payload);
    } catch (error) {
      const { failure, expected } = toSocketFailure(error);
      if (!expected) logger.error({ err: error, event, socketId: socket.id, userId }, 'socket event failed');
      outcome = { response: failure, disconnect: false };
    }
    const { response, disconnect } = outcome;
    logger.debug(
      { event, socketId: socket.id, userId, ok: response.ok, code: response.ok ? undefined : response.error.code },
      'socket event',
    );
    reply(response);
    // After the ack, so the client still learns why; `true` also closes the connection (no client retry).
    if (disconnect) socket.disconnect(true);
  }

  const listener = (payload: unknown, ack: unknown): void => {
    // `run` catches everything it awaits; the outer catch only guards a throwing ack callback (client-controlled).
    run(payload, ackCallback(ack)).catch((error: unknown) => {
      logger.error({ err: error, event, socketId: socket.id, userId }, 'socket ack failed');
    });
  };
  listen(socket, event, listener);
}

/**
 * Not generic on purpose: socket.io's listener type for a generic event name is a deferred conditional type that no
 * function satisfies, while the union of all client events resolves to the union of their listeners.
 */
function listen(socket: AppSocket, event: ClientEvent, listener: (payload: unknown, ack: unknown) => void): void {
  socket.on(event, listener);
}
