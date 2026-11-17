import { describe, expect, it } from 'vitest';

import { createMemorySocketEventLimiter } from '../event-limiter.js';

describe('createMemorySocketEventLimiter() (fixed window)', () => {
  function limiter(limit: number, windowMs: number) {
    let now = 1_000_000;
    const instance = createMemorySocketEventLimiter({ limit, windowMs, now: () => now });
    return {
      consume: (key: string) => instance.consume(key),
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('allows `limit` events per window and key, then reports the time to the window end', async () => {
    const { consume, advance } = limiter(2, 10_000);
    await expect(consume('7')).resolves.toStrictEqual({ allowed: true, remaining: 1 });
    await expect(consume('7')).resolves.toStrictEqual({ allowed: true, remaining: 0 });
    advance(4_000);
    await expect(consume('7')).resolves.toStrictEqual({ allowed: false, retryAfterMs: 6_000 });
  });

  it('counts keys separately', async () => {
    const { consume } = limiter(1, 10_000);
    await expect(consume('1')).resolves.toMatchObject({ allowed: true });
    await expect(consume('2')).resolves.toMatchObject({ allowed: true });
    await expect(consume('1')).resolves.toMatchObject({ allowed: false });
  });

  it('starts a fresh window once the old one ended', async () => {
    const { consume, advance } = limiter(1, 10_000);
    await consume('7');
    await expect(consume('7')).resolves.toMatchObject({ allowed: false });
    advance(10_000);
    await expect(consume('7')).resolves.toStrictEqual({ allowed: true, remaining: 0 });
  });
});
