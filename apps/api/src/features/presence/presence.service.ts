import type { UserSummary } from '@app/shared';
import type { Logger } from 'pino';

import { toUserSummary } from '../../db/selections.js';
import type { Actor } from '../../shared/auth/guards.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { PresenceRepository } from './presence.repository.js';
import type { PresenceStore } from './presence.store.js';

/**
 * Where presence deltas go (API.md §3): `presence.socket.ts` sends them to every socket except the user's own; unit
 * tests record them. Passed per call, because the socket.io server reaches presence only through its registrar.
 */
export interface PresenceEvents {
  /** `presence:joined`: the user's first open socket (F-88). */
  joined(user: UserSummary): void;
  /** `presence:left`: the user's last socket closed and the grace period passed without a reconnect (F-87). */
  left(userId: number): void;
}

/** The timer surface of the grace period (ADR-0009), injectable; the default reads the globals at call time. */
export interface PresenceTimers {
  setTimeout(callback: () => void, ms: number): PresenceTimer;
  clearTimeout(timer: PresenceTimer): void;
}

/** What `setTimeout` returns; only handed back to `clearTimeout`. */
export type PresenceTimer = ReturnType<typeof setTimeout>;

/**
 * Global timers looked up per call, so `vi.useFakeTimers()` also drives this default. `unref`: a pending grace timer
 * never keeps a stopping process (or a finished test worker) alive.
 */
const globalTimers: PresenceTimers = {
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  },
  clearTimeout(timer) {
    clearTimeout(timer);
  },
};

export interface PresenceServiceDeps {
  store: PresenceStore;
  repository: PresenceRepository;
  avatarUrl: AvatarUrl;
  /** `PRESENCE_GRACE_MS` (5 s by default): how long a user stays online after their last socket closed. */
  graceMs: number;
  logger: Pick<Logger, 'error'>;
  timers?: PresenceTimers;
}

export interface PresenceService {
  /**
   * A socket of `user` was accepted. Emits `joined` only when the user was not online before, so a second tab and a
   * reload within the grace period are silent (F-87, F-88). Cancels a pending leave check of the user.
   */
  connected(user: UserSummary, socketRef: string, events: PresenceEvents): Promise<void>;
  /**
   * A socket of the user closed. With other sockets still open nothing happens (B-43); after the last one the leave
   * check runs once `graceMs` passed and emits `left` only if no socket has been opened again by then (F-87).
   */
  disconnected(userId: number, socketRef: string, events: PresenceEvents): Promise<void>;
  /** `GET /api/presence`: every other online user, public fields only, ordered by name (F-86, F-90, B-46). */
  listOnline(actor: Actor): Promise<UserSummary[]>;
  /** Boot cleanup: cancels every pending leave check and deletes this namespace's presence keys (ADR-0009). */
  reset(): Promise<void>;
}

/**
 * Presence rules (ADR-0009). The truth lives in Redis and every transition is one atomic store call; the in-process
 * grace timers only decide *when* to ask the store whether a user is still idle. A stale timer is therefore harmless:
 * `markOfflineIfIdle` answers false as soon as the user has any socket again. Single instance in v1: with more
 * instances the timers would have to become distributed (ADR-0009, Consequences).
 */
export function createPresenceService({
  store,
  repository,
  avatarUrl,
  graceMs,
  logger,
  timers = globalTimers,
}: PresenceServiceDeps): PresenceService {
  /** At most one pending leave check per user. */
  const pendingLeaves = new Map<number, PresenceTimer>();

  function cancelLeave(userId: number): void {
    const timer = pendingLeaves.get(userId);
    if (timer === undefined) return;
    timers.clearTimeout(timer);
    pendingLeaves.delete(userId);
  }

  async function checkLeave(userId: number, events: PresenceEvents): Promise<void> {
    if (await store.markOfflineIfIdle(userId)) events.left(userId);
  }

  function scheduleLeave(userId: number, events: PresenceEvents): void {
    cancelLeave(userId);
    const timer = timers.setTimeout(() => {
      pendingLeaves.delete(userId);
      checkLeave(userId, events).catch((error: unknown) => {
        // The user stays in the online set until the next disconnect or the next boot cleanup; nothing to retry.
        logger.error({ err: error, userId }, 'presence leave check failed');
      });
    }, graceMs);
    pendingLeaves.set(userId, timer);
  }

  return {
    async connected(user, socketRef, events) {
      const { cameOnline } = await store.addSocket(user.id, socketRef);
      // After the store call, not before: if it fails, a pending leave check still cleans up the user's last socket.
      // A check that fires before this line sees the socket that was just added and leaves the user online.
      cancelLeave(user.id);
      if (cameOnline) events.joined(user);
    },

    async disconnected(userId, socketRef, events) {
      const remaining = await store.removeSocket(userId, socketRef);
      if (remaining === 0) scheduleLeave(userId, events);
    },

    async listOnline(actor) {
      const ids = (await store.onlineUserIds()).filter((id) => id !== actor.userId);
      if (ids.length === 0) return [];
      const rows = await repository.findSummariesByIds(ids);
      return rows.map((row) => toUserSummary(row, avatarUrl));
    },

    async reset() {
      for (const userId of [...pendingLeaves.keys()]) cancelLeave(userId);
      await store.clear();
    },
  };
}
