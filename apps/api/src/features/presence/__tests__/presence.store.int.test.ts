import { randomUUID } from 'node:crypto';

import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRedisClient, type RedisClient } from '../../../shared/redis/redis.js';
import { createRedisPresenceStore, presenceKeys, type PresenceStore } from '../presence.store.js';

/**
 * The Redis presence store (ADR-0009, F-91, B-44) on the run's real Redis 8. Every test uses its own `test-<uuid>`
 * prefix, so the files and tests sharing this Redis never see each other's keys.
 */

let redis: RedisClient;

beforeAll(async () => {
  redis = createRedisClient({ url: inject('redisUrl'), logger: pino({ level: 'silent' }) });
  await redis.connect();
});

afterAll(async () => {
  await redis.close();
});

function namespace(): { keyPrefix: string; store: PresenceStore } {
  const keyPrefix = `test-${randomUUID()}`;
  return { keyPrefix, store: createRedisPresenceStore({ redis, keyPrefix }) };
}

describe('createRedisPresenceStore()', () => {
  it('F-91: keys a set of <instanceId>:<socketId> per user and a set of online user ids under <prefix>:presence:', async () => {
    const { keyPrefix, store } = namespace();
    await store.addSocket(7, 'instance-a:socket-1');
    await store.addSocket(7, 'instance-b:socket-2');

    expect(await redis.sMembers(`${keyPrefix}:presence:sockets:7`)).toStrictEqual(
      expect.arrayContaining(['instance-a:socket-1', 'instance-b:socket-2']),
    );
    expect(await redis.sMembers(`${keyPrefix}:presence:online`)).toStrictEqual(['7']);
    expect(await redis.type(`${keyPrefix}:presence:sockets:7`)).toBe('set');
    // Presence keys carry no TTL (DATA-MODEL.md): they are cleaned on disconnect and on boot, never evicted.
    expect(await redis.pTTL(`${keyPrefix}:presence:online`)).toBe(-1);
  });

  it('addSocket(): counts sockets and reports cameOnline only for a user who was not online', async () => {
    const { store } = namespace();
    await expect(store.addSocket(1, 'i:a')).resolves.toStrictEqual({ sockets: 1, cameOnline: true });
    await expect(store.addSocket(1, 'i:b')).resolves.toStrictEqual({ sockets: 2, cameOnline: false });
    // B-45: a set, so the same socket twice is one entry.
    await expect(store.addSocket(1, 'i:b')).resolves.toStrictEqual({ sockets: 2, cameOnline: false });
  });

  it('F-87: a reconnect while the user is still online (grace period) is not a new arrival', async () => {
    const { store } = namespace();
    await store.addSocket(1, 'i:a');
    await expect(store.removeSocket(1, 'i:a')).resolves.toBe(0);
    await expect(store.addSocket(1, 'i:b')).resolves.toStrictEqual({ sockets: 1, cameOnline: false });
  });

  it('B-43: removeSocket() removes exactly the given socket, idempotently, and reports what is left', async () => {
    const { keyPrefix, store } = namespace();
    await store.addSocket(1, 'i:a');
    await store.addSocket(1, 'i:b');
    await store.addSocket(2, 'i:c');

    await expect(store.removeSocket(1, 'i:a')).resolves.toBe(1);
    await expect(store.removeSocket(1, 'i:a')).resolves.toBe(1);
    await expect(store.removeSocket(1, 'i:unknown')).resolves.toBe(1);
    expect(await redis.sMembers(`${keyPrefix}:presence:sockets:1`)).toStrictEqual(['i:b']);
    expect(await redis.sMembers(`${keyPrefix}:presence:sockets:2`)).toStrictEqual(['i:c']);

    await expect(store.removeSocket(1, 'i:b')).resolves.toBe(0);
    // Redis drops an empty set, so no empty per-user key is left behind.
    expect(await redis.exists(`${keyPrefix}:presence:sockets:1`)).toBe(0);
  });

  it('markOfflineIfIdle(): removes an idle user from the online set, once', async () => {
    const { store } = namespace();
    await store.addSocket(1, 'i:a');
    await store.addSocket(2, 'i:b');
    await store.removeSocket(1, 'i:a');

    await expect(store.markOfflineIfIdle(1)).resolves.toBe(true);
    await expect(store.markOfflineIfIdle(1)).resolves.toBe(false);
    await expect(store.onlineUserIds()).resolves.toStrictEqual([2]);
  });

  it('markOfflineIfIdle(): keeps a user who has a socket again', async () => {
    const { store } = namespace();
    await store.addSocket(1, 'i:a');
    await store.removeSocket(1, 'i:a');
    await store.addSocket(1, 'i:b');

    await expect(store.markOfflineIfIdle(1)).resolves.toBe(false);
    await expect(store.onlineUserIds()).resolves.toStrictEqual([1]);
  });

  it('markOfflineIfIdle(): is atomic against a concurrent reconnect (no lost user)', async () => {
    const { store } = namespace();
    await store.addSocket(1, 'i:a');
    await store.removeSocket(1, 'i:a');

    // Both sent in the same tick: whichever Redis runs first, the user ends up online exactly when a socket is open.
    const [wentOffline, added] = await Promise.all([store.markOfflineIfIdle(1), store.addSocket(1, 'i:b')]);

    expect(wentOffline).toBe(true);
    expect(added).toStrictEqual({ sockets: 1, cameOnline: true });
    await expect(store.onlineUserIds()).resolves.toStrictEqual([1]);
  });

  it('onlineUserIds(): returns numbers and ignores members that are not user ids', async () => {
    const { keyPrefix, store } = namespace();
    await store.addSocket(3, 'i:a');
    await store.addSocket(12, 'i:b');
    await redis.sAdd(`${keyPrefix}:presence:online`, ['garbage', '0', '-4', '1.5', '007']);

    const ids = await store.onlineUserIds();
    expect([...ids].sort((a, b) => a - b)).toStrictEqual([3, 12]);
  });

  it('F-91: a second store on the same namespace (another process, a restart) sees the same state', async () => {
    const { keyPrefix, store } = namespace();
    await store.addSocket(5, 'instance-a:s1');

    const other = createRedisPresenceStore({ redis, keyPrefix });
    await expect(other.onlineUserIds()).resolves.toStrictEqual([5]);
    await expect(other.addSocket(5, 'instance-b:s2')).resolves.toStrictEqual({ sockets: 2, cameOnline: false });
    await expect(store.removeSocket(5, 'instance-a:s1')).resolves.toBe(1);
  });

  it('B-44: clear() deletes every presence key of its namespace and nothing else', async () => {
    const { keyPrefix, store } = namespace();
    const neighbour = namespace();
    await store.addSocket(1, 'i:a');
    await store.addSocket(2, 'i:b');
    await neighbour.store.addSocket(1, 'i:n');
    // Other keys of the same app namespace (sessions, limits) survive the presence cleanup.
    await redis.set(`${keyPrefix}:sess:abc`, '{}');

    await expect(store.clear()).resolves.toBe(3);

    expect(await redis.keys(`${keyPrefix}:presence:*`)).toStrictEqual([]);
    await expect(store.onlineUserIds()).resolves.toStrictEqual([]);
    await expect(redis.get(`${keyPrefix}:sess:abc`)).resolves.toBe('{}');
    await expect(neighbour.store.onlineUserIds()).resolves.toStrictEqual([1]);
    await expect(store.clear()).resolves.toBe(0);
  });

  it('clear() matches its prefix literally, even with glob characters in it', async () => {
    const base = `test-${randomUUID()}`;
    const globbed = createRedisPresenceStore({ redis, keyPrefix: `${base}*` });
    const literal = createRedisPresenceStore({ redis, keyPrefix: `${base}x` });
    await globbed.addSocket(1, 'i:a');
    await literal.addSocket(1, 'i:b');

    await globbed.clear();

    await expect(globbed.onlineUserIds()).resolves.toStrictEqual([]);
    await expect(literal.onlineUserIds()).resolves.toStrictEqual([1]);
    expect(presenceKeys(`${base}*`).pattern).toBe(`${base}\\*:presence:*`);
  });
});
