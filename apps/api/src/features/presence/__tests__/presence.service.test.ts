import { UserSummary } from '@app/shared';
import { pino, type Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AvatarUrl } from '../../../shared/media/media-url.js';
import { createPresenceService, type PresenceService, type PresenceTimers } from '../presence.service.js';
import {
  createFakePresenceRepository,
  createFakePresenceStore,
  createRecordingPresenceEvents,
  summaryOf,
  summaryRow,
  type FakePresenceRepository,
  type FakePresenceStore,
  type RecordingPresenceEvents,
} from './fakes.js';

/**
 * Presence rules (ADR-0009, F-87, F-88, F-90, F-91; B-43, B-45, B-46) with the in-memory store and fake timers, so
 * the 5 s grace period is stepped through exactly instead of waited for.
 */

const GRACE_MS = 5_000;
const avatarUrl: AvatarUrl = (userId, key) => (key ? `/api/users/${String(userId)}/avatar?v=test` : null);

const ada = summaryRow(1, 'Ada', 'Lovelace');
const grace = summaryRow(2, 'Grace', 'Hopper', 'avatars/2/00000000-0000-4000-8000-000000000000.webp');
const alan = summaryRow(3, 'alan', 'Turing');

let store: FakePresenceStore;
let repository: FakePresenceRepository;
let events: RecordingPresenceEvents;
let logger: Logger;
/** Every JSON line the service logged (pino with an in-memory destination, so the real logger API is used). */
let logLines: Record<string, unknown>[];
let service: PresenceService;

beforeEach(() => {
  vi.useFakeTimers();
  store = createFakePresenceStore();
  repository = createFakePresenceRepository();
  repository.add(ada, grace, alan);
  events = createRecordingPresenceEvents();
  logLines = [];
  logger = pino(
    { level: 'error' },
    {
      write: (line: string) => {
        logLines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  service = createPresenceService({ store, repository, avatarUrl, graceMs: GRACE_MS, logger });
});

afterEach(() => {
  vi.useRealTimers();
});

const connect = (row: typeof ada, ref: string) => service.connected(summaryOf(row), ref, events);
const disconnect = (row: typeof ada, ref: string) => service.disconnected(row.id, ref, events);

describe('connected()', () => {
  it('F-88: emits joined with the handshake summary on the first socket and marks the user online', async () => {
    await connect(ada, 'i:a1');

    expect(events.recorded).toStrictEqual([{ type: 'joined', user: summaryOf(ada) }]);
    expect(store.online.has(ada.id)).toBe(true);
    expect(store.sockets.get(ada.id)).toStrictEqual(new Set(['i:a1']));
  });

  it('F-87: a second tab of the same user emits nothing (the user appears once)', async () => {
    await connect(ada, 'i:a1');
    await connect(ada, 'i:a2');

    expect(events.joinedIds()).toStrictEqual([ada.id]);
    expect(store.sockets.get(ada.id)?.size).toBe(2);
  });

  it('B-45: the same socket registered twice counts once (set semantics, no duplicate entries)', async () => {
    await connect(ada, 'i:a1');
    await connect(ada, 'i:a1');
    expect(store.sockets.get(ada.id)?.size).toBe(1);

    await disconnect(ada, 'i:a1');
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(events.leftIds()).toStrictEqual([ada.id]);
  });

  it('rejects when the store fails and emits nothing', async () => {
    store.fail();
    await expect(connect(ada, 'i:a1')).rejects.toThrow('unavailable');
    expect(events.recorded).toStrictEqual([]);
  });
});

describe('disconnected() and the grace period', () => {
  it('F-87, B-43: closing one of two tabs keeps the user online and emits nothing', async () => {
    await connect(ada, 'i:a1');
    await connect(ada, 'i:a2');
    await disconnect(ada, 'i:a1');
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);

    expect(events.leftIds()).toStrictEqual([]);
    expect(store.online.has(ada.id)).toBe(true);
    expect(store.sockets.get(ada.id)).toStrictEqual(new Set(['i:a2']));
  });

  it('F-87: closing the last tab emits left only after the grace period', async () => {
    await connect(ada, 'i:a1');
    await disconnect(ada, 'i:a1');

    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(events.leftIds()).toStrictEqual([]);
    expect(store.online.has(ada.id)).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(events.leftIds()).toStrictEqual([ada.id]);
    expect(store.online.has(ada.id)).toBe(false);
  });

  it('F-87: a reload within the grace period emits neither left nor a second joined', async () => {
    await connect(ada, 'i:a1');
    await disconnect(ada, 'i:a1');
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
    await connect(ada, 'i:a2');
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);

    expect(events.recorded).toStrictEqual([{ type: 'joined', user: summaryOf(ada) }]);
    expect(store.online.has(ada.id)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('F-88: a user who comes back after the grace period joins again', async () => {
    await connect(ada, 'i:a1');
    await disconnect(ada, 'i:a1');
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await connect(ada, 'i:a2');

    expect(events.recorded.map((event) => event.type)).toStrictEqual(['joined', 'left', 'joined']);
  });

  it('B-43: a disconnect of one user never removes another user', async () => {
    await connect(ada, 'i:a1');
    await connect(grace, 'i:g1');
    await disconnect(ada, 'i:a1');
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    expect(events.leftIds()).toStrictEqual([ada.id]);
    expect([...store.online]).toStrictEqual([grace.id]);
    expect(store.sockets.get(grace.id)).toStrictEqual(new Set(['i:g1']));
  });

  it('B-43: a repeated or unknown disconnect emits left at most once', async () => {
    await connect(ada, 'i:a1');
    await disconnect(ada, 'i:a1');
    await disconnect(ada, 'i:a1');
    await disconnect(ada, 'i:unknown');
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await disconnect(ada, 'i:a1');
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    expect(events.leftIds()).toStrictEqual([ada.id]);
  });

  it('keeps one pending leave check per user', async () => {
    await connect(ada, 'i:a1');
    await disconnect(ada, 'i:a1');
    await disconnect(ada, 'i:a1');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a stale leave check leaves a reconnected user online (the store decides, not the timer)', async () => {
    // A timer that is not cancelled (e.g. the reconnect is handled by another code path) must still be harmless.
    const scheduled: (() => void)[] = [];
    const manualTimers: PresenceTimers = {
      setTimeout: (callback) => {
        scheduled.push(callback);
        return setTimeout(() => undefined, 0);
      },
      clearTimeout: () => undefined,
    };
    const manual = createPresenceService({
      store,
      repository,
      avatarUrl,
      graceMs: GRACE_MS,
      logger,
      timers: manualTimers,
    });
    await manual.connected(summaryOf(ada), 'i:a1', events);
    await manual.disconnected(ada.id, 'i:a1', events);
    await manual.connected(summaryOf(ada), 'i:a2', events);
    for (const fire of scheduled) fire();
    await vi.advanceTimersByTimeAsync(0);

    expect(events.leftIds()).toStrictEqual([]);
    expect(store.online.has(ada.id)).toBe(true);
  });

  it('logs a failing leave check instead of throwing, and emits nothing', async () => {
    await connect(ada, 'i:a1');
    await disconnect(ada, 'i:a1');
    store.fail();
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    expect(events.leftIds()).toStrictEqual([]);
    expect(logLines).toMatchObject([
      {
        level: 50,
        userId: ada.id,
        msg: 'presence leave check failed',
        err: { message: 'fake presence store: unavailable' },
      },
    ]);
  });

  it('rejects when removing the socket fails and schedules nothing', async () => {
    await connect(ada, 'i:a1');
    store.fail();
    await expect(disconnect(ada, 'i:a1')).rejects.toThrow('unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a grace period of 0 still emits left asynchronously, once', async () => {
    const instant = createPresenceService({ store, repository, avatarUrl, graceMs: 0, logger });
    await instant.connected(summaryOf(ada), 'i:a1', events);
    await instant.disconnected(ada.id, 'i:a1', events);
    expect(events.leftIds()).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.leftIds()).toStrictEqual([ada.id]);
  });
});

describe('listOnline()', () => {
  it('B-46, F-86: lists every other online user, never the viewer', async () => {
    await connect(ada, 'i:a1');
    await connect(grace, 'i:g1');

    const items = await service.listOnline({ userId: ada.id });

    expect(items.map((user) => user.id)).toStrictEqual([grace.id]);
    expect(repository.calls).toStrictEqual([[grace.id]]);
  });

  it('F-90: returns public summaries with the avatar URL built from the key, in name order', async () => {
    await connect(grace, 'i:g1');
    await connect(alan, 'i:t1');
    await connect(ada, 'i:a1');

    const items = await service.listOnline({ userId: 99 });

    expect(items).toStrictEqual([
      { id: ada.id, firstName: 'Ada', lastName: 'Lovelace', avatarUrl: null },
      { id: alan.id, firstName: 'alan', lastName: 'Turing', avatarUrl: null },
      { id: grace.id, firstName: 'Grace', lastName: 'Hopper', avatarUrl: '/api/users/2/avatar?v=test' },
    ]);
    for (const item of items) expect(UserSummary.parse(item)).toStrictEqual(item);
  });

  it('does not query the database when nobody else is online', async () => {
    await connect(ada, 'i:a1');
    await expect(service.listOnline({ userId: ada.id })).resolves.toStrictEqual([]);
    expect(repository.calls).toStrictEqual([]);
  });

  it('F-87: keeps listing a user during the grace period and drops them afterwards', async () => {
    await connect(grace, 'i:g1');
    await disconnect(grace, 'i:g1');
    await expect(service.listOnline({ userId: ada.id })).resolves.toHaveLength(1);

    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await expect(service.listOnline({ userId: ada.id })).resolves.toStrictEqual([]);
  });

  it('skips online ids that have no user row', async () => {
    await service.connected({ id: 404, firstName: 'Gone', lastName: 'User', avatarUrl: null }, 'i:x', events);
    await connect(grace, 'i:g1');
    const items = await service.listOnline({ userId: ada.id });
    expect(items.map((user) => user.id)).toStrictEqual([grace.id]);
  });
});

describe('reset()', () => {
  it('B-44: clears every presence entry and cancels pending leave checks', async () => {
    await connect(ada, 'i:a1');
    await connect(grace, 'i:g1');
    await disconnect(grace, 'i:g1');
    expect(vi.getTimerCount()).toBe(1);

    await service.reset();

    expect(vi.getTimerCount()).toBe(0);
    expect(store.online.size).toBe(0);
    expect(store.sockets.size).toBe(0);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(events.leftIds()).toStrictEqual([]);
  });
});
