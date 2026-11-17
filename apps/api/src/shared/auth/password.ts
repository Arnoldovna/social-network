import { randomUUID } from 'node:crypto';

import * as argon2 from 'argon2';

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
  needsRehash(hash: string): boolean;
}

/**
 * argon2id with the library defaults (m=64 MiB, t=3, p=4), which exceed the OWASP minimum
 * (m=19 MiB, t=2, p=1). Pin them explicitly so a library upgrade never silently weakens hashes.
 */
const OPTIONS = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 4 } as const;

export const argon2Hasher: PasswordHasher = {
  hash: (plain) => argon2.hash(plain, OPTIONS),
  verify: (hash, plain) => argon2.verify(hash, plain),
  needsRehash: (hash) => argon2.needsRehash(hash, OPTIONS),
};

/**
 * Verify against this when the user does not exist, so "unknown email" and "wrong password"
 * take the same time. Generate once at startup: `await hasher.hash(randomUUID())`.
 */
export async function createTimingDummy(hasher: PasswordHasher): Promise<string> {
  return hasher.hash(randomUUID());
}
