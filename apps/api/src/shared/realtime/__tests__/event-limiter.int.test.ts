import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRedisClient, type RedisClient } from '../../redis/redis.js';
import { createRedisSocketEventLimiter } from '../event-limiter.js';

/** The Redis fixed window of the socket limiters (F-84, OVERVIEW §10) on the run's real Redis 8. */

let redis: RedisClient;

beforeAll(async () => {
  redis = createRedisClient({ url: inject('redisUrl'), logger: pino({ level: 'silent' }) });
  await redis.connect();
});

afterAll(async () => {
  await redis.close();
});

function limiter(limit: number, windowMs: number, name = 'chat-send') {
  const prefix = `test-${randomUUID()}`;
  return { prefix, limiter: createRedisSocketEventLimiter({ redis, prefix, name, limit, windowMs }) };
}

describe('createRedisSocketEventLimiter()', () => {
  it('allows `limit` events per key and window, then answers with the time to the window end', async () => {
    const { limiter: chat } = limiter(2, 10_000);
    await expect(chat.consume('7')).resolves.toStrictEqual({ allowed: true, remaining: 1 });
    await expect(chat.consume('7')).resolves.toStrictEqual({ allowed: true, remaining: 0 });
    const rejected = await chat.consume('7');
    expect(rejected.allowed).toBe(false);
    if (rejected.allowed) return;
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
    expect(rejected.retryAfterMs).toBeLessThanOrEqual(10_000);
  });

  it('keys the counter as <prefix>:rl:<name>:<key> with the window as its TTL', async () => {
    const { prefix, limiter: chat } = limiter(5, 10_000);
    await chat.consume('42');
    await chat.consume('42');
    const key = `${prefix}:rl:chat-send:42`;
    await expect(redis.get(key)).resolves.toBe('2');
    const ttl = await redis.pTTL(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_000);
  });

  it('does not extend the window with later events (fixed, not sliding)', async () => {
    const { prefix, limiter: chat } = limiter(5, 10_000);
    await chat.consume('1');
    const key = `${prefix}:rl:chat-send:1`;
    const first = await redis.pTTL(key);
    await delay(50);
    await chat.consume('1');
    expect(await redis.pTTL(key)).toBeLessThan(first);
  });

  it('starts a new window after the old one expired', async () => {
    const { limiter: chat } = limiter(1, 200);
    await expect(chat.consume('7')).resolves.toMatchObject({ allowed: true });
    await expect(chat.consume('7')).resolves.toMatchObject({ allowed: false });
    await delay(260);
    await expect(chat.consume('7')).resolves.toStrictEqual({ allowed: true, remaining: 0 });
  });

  it('is atomic: of 20 concurrent events exactly `limit` pass', async () => {
    const { limiter: chat } = limiter(5, 10_000);
    const decisions = await Promise.all(Array.from({ length: 20 }, () => chat.consume('7')));
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
  });

  it('keeps keys, limiter names and app prefixes apart', async () => {
    const { prefix, limiter: chat } = limiter(1, 10_000);
    const wall = createRedisSocketEventLimiter({ redis, prefix, name: 'wall-join', limit: 1, windowMs: 10_000 });
    const otherApp = limiter(1, 10_000).limiter;
    await expect(chat.consume('7')).resolves.toMatchObject({ allowed: true });
    await expect(chat.consume('8')).resolves.toMatchObject({ allowed: true });
    await expect(wall.consume('7')).resolves.toMatchObject({ allowed: true });
    await expect(otherApp.consume('7')).resolves.toMatchObject({ allowed: true });
    await expect(chat.consume('7')).resolves.toMatchObject({ allowed: false });
  });

  it('rejects when Redis is unavailable, so callers can fail closed', async () => {
    const broken = createRedisClient({ url: inject('redisUrl'), logger: pino({ level: 'silent' }) });
    await broken.connect();
    const chat = createRedisSocketEventLimiter({
      redis: broken,
      prefix: `test-${randomUUID()}`,
      name: 'chat-send',
      limit: 1,
      windowMs: 1_000,
    });
    await broken.close();
    await expect(chat.consume('7')).rejects.toThrow();
  });
});
