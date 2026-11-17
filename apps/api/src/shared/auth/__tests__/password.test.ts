import * as argon2 from 'argon2';
import { describe, expect, it } from 'vitest';

import { argon2Hasher, createTimingDummy } from '../password.js';

const password = 'correct horse battery staple';

/** The real argon2id hasher (ADR-0006, F-17, B-16). Each hash costs ~64 MiB and some 100 ms, so the file stays small. */
describe('argon2Hasher', () => {
  it('F-17, B-16: hashes with argon2id and the pinned parameters m=65536, t=3, p=4', async () => {
    const hash = await argon2Hasher.hash(password);

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(hash).not.toContain(password);
  });

  it('F-15: verifies only the exact password (no trimming, case-sensitive)', async () => {
    const hash = await argon2Hasher.hash(password);

    await expect(argon2Hasher.verify(hash, password)).resolves.toBe(true);
    await expect(argon2Hasher.verify(hash, `${password} `)).resolves.toBe(false);
    await expect(argon2Hasher.verify(hash, password.toUpperCase())).resolves.toBe(false);
  });

  it('B-16: a 256-character password keeps every character (no bcrypt-style 72-byte truncation)', async () => {
    const long = 'a'.repeat(256);
    const hash = await argon2Hasher.hash(long);

    await expect(argon2Hasher.verify(hash, long)).resolves.toBe(true);
    await expect(argon2Hasher.verify(hash, `${'a'.repeat(255)}b`)).resolves.toBe(false);
  });

  it('salts every hash: the same password never yields the same hash twice', async () => {
    const [first, second] = await Promise.all([argon2Hasher.hash(password), argon2Hasher.hash(password)]);

    expect(first).not.toBe(second);
  });

  it('ADR-0006: needsRehash is false for its own hashes and true for weaker cost parameters', async () => {
    const current = await argon2Hasher.hash(password);
    const weaker = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    expect(argon2Hasher.needsRehash(current)).toBe(false);
    expect(argon2Hasher.needsRehash(weaker)).toBe(true);
    // A hash with older parameters still verifies, so a successful login can store the upgraded hash.
    await expect(argon2Hasher.verify(weaker, password)).resolves.toBe(true);
  });
});

describe('createTimingDummy', () => {
  it('B-13: is a real argon2id hash with the pinned parameters, so verifying against it costs as much as a real one', async () => {
    const dummy = await createTimingDummy(argon2Hasher);

    expect(dummy).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(argon2Hasher.needsRehash(dummy)).toBe(false);
  });

  it('B-13: matches no password a client could guess (it hashes a random UUID)', async () => {
    const [first, second] = await Promise.all([createTimingDummy(argon2Hasher), createTimingDummy(argon2Hasher)]);

    expect(first).not.toBe(second);
    await expect(argon2Hasher.verify(first, '')).resolves.toBe(false);
    await expect(argon2Hasher.verify(first, password)).resolves.toBe(false);
  });
});
