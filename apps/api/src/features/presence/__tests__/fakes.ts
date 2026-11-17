import type { UserSummary } from '@app/shared';

import type { UserSummaryRow } from '../../../db/selections.js';
import type { PresenceRepository } from '../presence.repository.js';
import type { PresenceEvents } from '../presence.service.js';
import type { PresenceStore } from '../presence.store.js';

/**
 * Test doubles of the presence feature (BUILD-ORDER Phase 2: the `PresenceStore` fake lives here, not in `test/*`).
 * Each implements the same port as the real adapter.
 */

export interface FakePresenceStore extends PresenceStore {
  /** The open sockets per user, as the Redis sets hold them; tests read it directly. */
  readonly sockets: ReadonlyMap<number, ReadonlySet<string>>;
  /** The online set. */
  readonly online: ReadonlySet<number>;
  /** Makes every later call reject with `error` until `recover()`; the failing call changes nothing. */
  fail(error?: Error): void;
  recover(): void;
}

/** In-memory `PresenceStore` with the Redis store's semantics: set membership, atomic calls, idle-only offline. */
export function createFakePresenceStore(): FakePresenceStore {
  const sockets = new Map<number, Set<string>>();
  const online = new Set<number>();
  let failure: Error | undefined;

  /** Resolves on a microtask like a network reply, so callers cannot depend on synchronous completion. */
  const reply = <T>(run: () => T): Promise<T> => (failure ? Promise.reject(failure) : Promise.resolve().then(run));

  return {
    sockets,
    online,
    fail(error = new Error('fake presence store: unavailable')) {
      failure = error;
    },
    recover() {
      failure = undefined;
    },
    addSocket(userId, socketRef) {
      return reply(() => {
        const set = sockets.get(userId) ?? new Set<string>();
        set.add(socketRef);
        sockets.set(userId, set);
        const cameOnline = !online.has(userId);
        online.add(userId);
        return { sockets: set.size, cameOnline };
      });
    },
    removeSocket(userId, socketRef) {
      return reply(() => {
        const set = sockets.get(userId);
        if (!set) return 0;
        set.delete(socketRef);
        // Redis deletes a set when its last member goes.
        if (set.size === 0) sockets.delete(userId);
        return set.size;
      });
    },
    markOfflineIfIdle(userId) {
      return reply(() => {
        if ((sockets.get(userId)?.size ?? 0) > 0) return false;
        return online.delete(userId);
      });
    },
    onlineUserIds() {
      return reply(() => [...online]);
    },
    clear() {
      return reply(() => {
        const deleted = sockets.size + (online.size > 0 ? 1 : 0);
        sockets.clear();
        online.clear();
        return deleted;
      });
    },
  };
}

export interface FakePresenceRepository extends PresenceRepository {
  /** Every id list the service asked for, in call order. */
  readonly calls: (readonly number[])[];
  add(...rows: UserSummaryRow[]): void;
}

/** Holds user rows and answers like the SQL: requested ids only, ordered by lower(first), lower(last), id. */
export function createFakePresenceRepository(): FakePresenceRepository {
  const rows = new Map<number, UserSummaryRow>();
  const calls: (readonly number[])[] = [];
  const byName = (a: UserSummaryRow, b: UserSummaryRow): number =>
    a.firstName.toLowerCase().localeCompare(b.firstName.toLowerCase()) ||
    a.lastName.toLowerCase().localeCompare(b.lastName.toLowerCase()) ||
    a.id - b.id;

  return {
    calls,
    add(...added) {
      for (const row of added) rows.set(row.id, row);
    },
    findSummariesByIds(ids) {
      calls.push([...ids]);
      const found = ids.map((id) => rows.get(id)).filter((row) => row !== undefined);
      return Promise.resolve(found.sort(byName));
    },
  };
}

export type RecordedPresenceEvent = { type: 'joined'; user: UserSummary } | { type: 'left'; userId: number };

export interface RecordingPresenceEvents extends PresenceEvents {
  /** Every delta in emit order. */
  readonly recorded: RecordedPresenceEvent[];
  joinedIds(): number[];
  leftIds(): number[];
}

export function createRecordingPresenceEvents(): RecordingPresenceEvents {
  const recorded: RecordedPresenceEvent[] = [];
  return {
    recorded,
    joined(user) {
      recorded.push({ type: 'joined', user });
    },
    left(userId) {
      recorded.push({ type: 'left', userId });
    },
    joinedIds: () => recorded.flatMap((event) => (event.type === 'joined' ? [event.user.id] : [])),
    leftIds: () => recorded.flatMap((event) => (event.type === 'left' ? [event.userId] : [])),
  };
}

/** A users row restricted to the summary columns, as `db.select(userSummaryColumns)` returns it. */
export function summaryRow(id: number, firstName: string, lastName: string, avatarKey: string | null = null) {
  return { id, firstName, lastName, avatarKey } satisfies UserSummaryRow;
}

/** The `UserSummary` the handshake would load for `summaryRow(...)` without an avatar. */
export function summaryOf(row: UserSummaryRow): UserSummary {
  return { id: row.id, firstName: row.firstName, lastName: row.lastName, avatarUrl: null };
}
