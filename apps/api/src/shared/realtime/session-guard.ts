import type { Logger } from 'pino';

import type { RedisClient } from '../redis/redis.js';
import { sessionKeyPrefix } from '../security/session.js';
import { rooms } from './rooms.js';
import type { AppServer, AppSocket } from './types.js';

/** ADR-0005: open sockets are swept once a minute. */
export const SESSION_SWEEP_INTERVAL_MS = 60_000;

export interface SweepResult {
  /** Distinct session ids among the open sockets. */
  checked: number;
  /** Sessions whose sockets were disconnected because the session no longer exists in Redis. */
  disconnected: number;
}

/**
 * Bounds every socket by the lifetime of the session that opened it (ADR-0005, API.md §3). A session ends by TTL
 * expiry, logout (`destroy`) or a new login (`regenerate`); its sockets must stop receiving chat, wall and presence
 * events and stop counting as online.
 */
export interface SessionGuard {
  /**
   * Per-event check for mutating events (`chat:send`, `wall:join`): true while the socket's session exists. On
   * false the caller acks `unauthorized` and disconnects the socket (`onClientEvent` in `ack.ts` does both).
   */
  isAlive(socket: Pick<AppSocket, 'data'>): Promise<boolean>;
  /** One pass: a pipelined `EXISTS` per distinct session id; sockets of missing sessions are disconnected. */
  sweep(): Promise<SweepResult>;
  /** Starts the periodic sweep (idempotent). The timer is unref'd, so it never keeps the process alive. */
  start(): void;
  /** Stops the periodic sweep (graceful shutdown, before io closes). */
  stop(): void;
}

export interface SessionGuardOptions {
  io: AppServer;
  redis: RedisClient;
  /** The app key prefix the session store uses (`createSessionMiddleware({ prefix })`). */
  prefix: string;
  logger: Pick<Logger, 'warn' | 'info'>;
  intervalMs?: number;
}

export function createSessionGuard({
  io,
  redis,
  prefix,
  logger,
  intervalMs = SESSION_SWEEP_INTERVAL_MS,
}: SessionGuardOptions): SessionGuard {
  const sessionKeys = sessionKeyPrefix(prefix);
  const keyOf = (sessionId: string): string => sessionKeys + sessionId;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<SweepResult> | undefined;

  async function runSweep(): Promise<SweepResult> {
    // fetchSockets() instead of the local namespace map: it keeps working across instances with a Redis adapter.
    const sockets = await io.fetchSockets();
    const sessionIds = [...new Set(sockets.map((socket) => socket.data.sessionId))];
    // Commands issued in the same tick are pipelined by node-redis: one round trip for all ids.
    const exists = await Promise.all(sessionIds.map((sessionId) => redis.exists(keyOf(sessionId))));
    const expired = sessionIds.filter((_sessionId, index) => exists[index] === 0);
    for (const sessionId of expired) io.in(rooms.session(sessionId)).disconnectSockets(true);
    if (expired.length > 0) logger.info({ sessions: expired.length }, 'disconnected sockets of ended sessions');
    return { checked: sessionIds.length, disconnected: expired.length };
  }

  const guard: SessionGuard = {
    async isAlive(socket) {
      // `data` is typed complete but is `{}` until the handshake fills it: a socket without a session id never
      // passed the handshake, so it is treated as dead rather than trusted.
      const sessionId: string | undefined = socket.data.sessionId;
      if (!sessionId) return false;
      return (await redis.exists(keyOf(sessionId))) === 1;
    },
    sweep() {
      // A slow sweep (Redis hiccup) must not pile up concurrent passes over the same sockets.
      running ??= runSweep().finally(() => {
        running = undefined;
      });
      return running;
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        guard.sweep().catch((error: unknown) => {
          // The next tick retries; a missed pass only delays the disconnect by one interval.
          logger.warn({ err: error }, 'session sweep failed');
        });
      }, intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
  return guard;
}
