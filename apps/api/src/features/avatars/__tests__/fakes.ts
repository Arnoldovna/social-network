import type { PublicUserRow } from '../../../db/selections.js';
import { parseAvatarKey } from '../../../shared/media/media-url.js';
import { AVATAR_CONTENT_TYPE, type ProcessedAvatar } from '../../../shared/uploads/process-image.js';
import type { AvatarsRepository, AvatarSwap } from '../avatars.repository.js';
import type { WarnLogger } from '../avatars.service.js';

/** Feature-specific test doubles (BUILD-ORDER rule 5). Generic infra fakes (storage, clock) live in test/fakes.ts. */

// ---------------------------------------------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------------------------------------------

export interface FakeAvatarsRepository extends AvatarsRepository {
  /** Every user by id; tests read and seed it directly. */
  readonly users: Map<number, PublicUserRow>;
  /** Adds a user (defaults: names `Test User`, no bio, no avatar) and returns the stored row. */
  addUser(fields: Partial<PublicUserRow> & Pick<PublicUserRow, 'id'>): PublicUserRow;
  /** Makes every later `swapAvatarKey` reject with `error` (nothing is changed), until `recover()`. */
  failSwaps(error?: Error): void;
  recover(): void;
}

/**
 * In-memory `AvatarsRepository` with the same contract as the Drizzle one: the swap replaces the key and reports the
 * key it replaced, and it enforces `users_avatar_key_chk` (only the row's own server-made keys), so a service bug that
 * builds a foreign key fails here as it would in Postgres.
 */
export function createFakeAvatarsRepository(): FakeAvatarsRepository {
  const users = new Map<number, PublicUserRow>();
  let swapFailure: Error | undefined;

  return {
    users,
    addUser(fields) {
      const row: PublicUserRow = { firstName: 'Test', lastName: 'User', bio: null, avatarKey: null, ...fields };
      users.set(row.id, row);
      return row;
    },
    failSwaps(error = new Error('fake repository: swap failed')) {
      swapFailure = error;
    },
    recover() {
      swapFailure = undefined;
    },
    swapAvatarKey(userId, newKey): Promise<AvatarSwap | undefined> {
      if (swapFailure) return Promise.reject(swapFailure);
      const current = users.get(userId);
      if (!current) return Promise.resolve(undefined);
      if (parseAvatarKey(newKey)?.userId !== userId) {
        return Promise.reject(new Error('violates check constraint "users_avatar_key_chk"'));
      }
      const updated = { ...current, avatarKey: newKey };
      users.set(userId, updated);
      return Promise.resolve({ oldKey: current.avatarKey, user: { ...updated } });
    },
    findAvatarKey(userId) {
      const user = users.get(userId);
      return Promise.resolve(user ? { avatarKey: user.avatarKey } : undefined);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Image processing
// ---------------------------------------------------------------------------------------------------------------

export interface FakeImageProcessor {
  /** Stands in for `processAvatar`: answers a deterministic "re-encoded" buffer derived from the input. */
  process: (buffer: Buffer) => Promise<ProcessedAvatar>;
  /** Every input buffer in call order. */
  readonly inputs: Buffer[];
  /** Makes every later call reject with `error` (e.g. the 422 of an oversized image). */
  fail(error: Error): void;
}

/** What the fake processor stores for `input`: recognisable in assertions, never the original bytes. */
export function fakeProcessedBytes(input: Buffer): Buffer {
  return Buffer.concat([Buffer.from('webp:'), input]);
}

export function createFakeImageProcessor(): FakeImageProcessor {
  const inputs: Buffer[] = [];
  let failure: Error | undefined;
  return {
    inputs,
    fail(error) {
      failure = error;
    },
    process(buffer) {
      inputs.push(buffer);
      if (failure) return Promise.reject(failure);
      return Promise.resolve({ buffer: fakeProcessedBytes(buffer), contentType: AVATAR_CONTENT_TYPE });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------------------------------------------

export interface RecordedWarning {
  details: Record<string, unknown>;
  message: string;
}

export interface FakeLogger extends WarnLogger {
  readonly warnings: RecordedWarning[];
}

export function createFakeLogger(): FakeLogger {
  const warnings: RecordedWarning[] = [];
  return {
    warnings,
    warn(details, message) {
      warnings.push({ details, message });
    },
  };
}
