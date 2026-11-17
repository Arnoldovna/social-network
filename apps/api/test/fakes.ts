import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

import type { FriendshipState, ServerToClientEvents } from '@app/shared';

import { deriveFriendshipState } from '../src/features/friends/friendship-state.js';
import type { PasswordHasher } from '../src/shared/auth/password.js';
import type { FriendshipReader } from '../src/shared/ports/friendship-reader.js';
import type { RealtimePublisher } from '../src/shared/realtime/types.js';
import type { ObjectStorage } from '../src/shared/storage/object-storage.js';

/**
 * Generic infrastructure fakes for unit tests (ADR-0016, BUILD-ORDER 1b "Test helpers"; frozen after Phase 1b). Each
 * implements the same port as the real adapter, so services are built with these instead of `vi.mock`. Repository
 * fakes, the `PresenceStore` fake and feature fixtures belong to each feature's own `__tests__/{fakes,fixtures}.ts`.
 */

// ---------------------------------------------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------------------------------------------

export interface StoredObject {
  body: Uint8Array;
  contentType: string;
}

export type StorageOperation = 'put' | 'get' | 'delete';

export interface FakeStorage extends ObjectStorage {
  /** Every stored object by key; tests read and seed it directly. */
  readonly objects: Map<string, StoredObject>;
  /**
   * Makes every later call of `operation` reject with `error` until `recover(operation)` (e.g. "the S3 put fails, so
   * the database stays unchanged"). The failing call changes nothing.
   */
  fail(operation: StorageOperation, error?: Error): void;
  recover(operation?: StorageOperation): void;
  /** What `isReady()` answers (readiness tests); defaults to true. */
  ready: boolean;
  /** Safe to pass around unbound (readiness checks): it reads `ready` through a closure, not `this`. */
  isReady: () => Promise<boolean>;
}

/** The error a missing key produces, shaped like the AWS SDK's (`name: 'NoSuchKey'`), so callers can map it alike. */
export function noSuchKeyError(key: string): Error {
  const error = new Error(`The specified key does not exist: ${key}`);
  error.name = 'NoSuchKey';
  return error;
}

/** In-memory `ObjectStorage`. Bodies are copied on put and get, so a caller can never mutate a stored object. */
export function createFakeStorage(): FakeStorage {
  const objects = new Map<string, StoredObject>();
  const failures = new Map<StorageOperation, Error>();
  const failure = (operation: StorageOperation): Promise<never> | undefined => {
    const error = failures.get(operation);
    return error ? Promise.reject(error) : undefined;
  };

  const storage: FakeStorage = {
    objects,
    ready: true,
    fail(operation, error = new Error(`fake storage: ${operation} failed`)) {
      failures.set(operation, error);
    },
    recover(operation) {
      if (operation) failures.delete(operation);
      else failures.clear();
    },
    put(key, body, contentType) {
      const failed = failure('put');
      if (failed) return failed;
      objects.set(key, { body: Uint8Array.from(body), contentType });
      return Promise.resolve();
    },
    get(key) {
      const failed = failure('get');
      if (failed) return failed;
      const object = objects.get(key);
      if (!object) return Promise.reject(noSuchKeyError(key));
      return Promise.resolve({
        body: Readable.from([Buffer.from(object.body)]),
        contentType: object.contentType,
      });
    },
    delete(key) {
      const failed = failure('delete');
      if (failed) return failed;
      // S3 answers a delete of a missing key with success too.
      objects.delete(key);
      return Promise.resolve();
    },
    // A closure over `storage`, not `this`: callers pass `storage.isReady` around unbound (readiness checks).
    isReady: () => Promise.resolve(storage.ready),
  };
  return storage;
}

// ---------------------------------------------------------------------------------------------------------------
// Realtime publisher
// ---------------------------------------------------------------------------------------------------------------

/** One `emitToRoom` call, discriminated by `event` so `args` keeps the event's payload type. */
export type RecordedEmit = {
  [E in keyof ServerToClientEvents]: { room: string; event: E; args: Parameters<ServerToClientEvents[E]> };
}[keyof ServerToClientEvents];

export interface RecordedLeave {
  socketsInRoom: string;
  room: string;
}

export interface FakePublisher extends RealtimePublisher {
  /** Every emit in call order. */
  readonly emits: RecordedEmit[];
  /** Every `leaveRoom` call in call order. */
  readonly leaves: RecordedLeave[];
  /** Every `disconnectSession` session id in call order. */
  readonly disconnectedSessions: string[];
  /** The emits of one event, typed by that event. */
  emitsOf<E extends keyof ServerToClientEvents>(event: E): Extract<RecordedEmit, { event: E }>[];
  /** Forgets everything recorded so far. */
  clear(): void;
}

/** A `RealtimePublisher` that reaches no socket and records every call (ADR-0008: services are unit-tested with it). */
export function createFakePublisher(): FakePublisher {
  const emits: RecordedEmit[] = [];
  const leaves: RecordedLeave[] = [];
  const disconnectedSessions: string[] = [];

  const isEvent = <E extends keyof ServerToClientEvents>(
    event: E,
    emit: RecordedEmit,
  ): emit is Extract<RecordedEmit, { event: E }> => emit.event === event;

  return {
    emits,
    leaves,
    disconnectedSessions,
    emitToRoom(room, event, ...args) {
      // TypeScript cannot correlate the generic `event` with `args` inside the union; the signature already does.
      emits.push({ room, event, args } as RecordedEmit);
    },
    leaveRoom(socketsInRoom, room) {
      leaves.push({ socketsInRoom, room });
    },
    disconnectSession(sessionId) {
      disconnectedSessions.push(sessionId);
    },
    emitsOf(event) {
      return emits.filter((emit) => isEvent(event, emit));
    },
    clear() {
      emits.length = 0;
      leaves.length = 0;
      disconnectedSessions.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Friendship reader
// ---------------------------------------------------------------------------------------------------------------

export type StoredFriendshipStatus = 'pending' | 'accepted';

export interface FakeFriendshipReader extends FriendshipReader {
  /**
   * Stores the one row of the unordered pair, like `friendships` (DATA-MODEL.md): `requesterId` asked
   * `addresseeId`. Replaces an existing row of the same pair in either direction. A self pair throws, as the
   * `friendships_not_self_chk` constraint does.
   */
  set(requesterId: number, addresseeId: number, status: StoredFriendshipStatus): void;
  /** Deletes the pair's row in either direction (decline, cancel, unfriend). */
  remove(a: number, b: number): void;
}

interface FriendshipRow {
  requesterId: number;
  addresseeId: number;
  status: StoredFriendshipStatus;
}

const pairKey = (a: number, b: number): string => `${String(Math.min(a, b))}:${String(Math.max(a, b))}`;

/**
 * In-memory `FriendshipReader` for users and wall unit tests. States come from the same `deriveFriendshipState` the
 * real reader uses, so the fake and Postgres cannot disagree about directions.
 */
export function createFakeFriendshipReader(): FakeFriendshipReader {
  const rows = new Map<string, FriendshipRow>();
  const stateBetween = (me: number, them: number): FriendshipState =>
    deriveFriendshipState(rows.get(pairKey(me, them)), me);

  return {
    set(requesterId, addresseeId, status) {
      if (requesterId === addresseeId) throw new RangeError('A user cannot have a friendship with themselves.');
      rows.set(pairKey(requesterId, addresseeId), { requesterId, addresseeId, status });
    },
    remove(a, b) {
      rows.delete(pairKey(a, b));
    },
    stateBetween(me, them) {
      return Promise.resolve(stateBetween(me, them));
    },
    areFriends(a, b) {
      return Promise.resolve(rows.get(pairKey(a, b))?.status === 'accepted');
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Password hasher
// ---------------------------------------------------------------------------------------------------------------

/** Prefix of every hash the fast hasher produces; anything else "needs a rehash" (e.g. a stored argon2id hash). */
export const FAST_HASH_PREFIX = '$fast$';

/**
 * A `PasswordHasher` for unit tests: salted SHA-256 instead of argon2id, so a service test never pays 64 MiB and three
 * passes per hash. Same contract: different salts per hash, `verify` compares in constant time and answers false for
 * a malformed hash instead of throwing. Never use it outside tests.
 */
export function createFastHasher(): PasswordHasher {
  const digest = (salt: string, plain: string): Buffer => createHash('sha256').update(`${salt}:${plain}`).digest();

  return {
    hash(plain) {
      const salt = randomBytes(8).toString('hex');
      return Promise.resolve(`${FAST_HASH_PREFIX}${salt}$${digest(salt, plain).toString('hex')}`);
    },
    verify(hash, plain) {
      if (!hash.startsWith(FAST_HASH_PREFIX)) return Promise.resolve(false);
      const [salt, expectedHex] = hash.slice(FAST_HASH_PREFIX.length).split('$');
      if (salt === undefined || expectedHex === undefined) return Promise.resolve(false);
      const expected = Buffer.from(expectedHex, 'hex');
      const actual = digest(salt, plain);
      return Promise.resolve(expected.length === actual.length && timingSafeEqual(expected, actual));
    },
    needsRehash(hash) {
      return !hash.startsWith(FAST_HASH_PREFIX);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------------------------------------------

export interface FakeClock {
  /** The current fake time as a new `Date` (callers may mutate it without moving the clock). */
  now(): Date;
  /** The current fake time in epoch milliseconds (for `() => number` clocks such as the memory event limiter). */
  nowMs(): number;
  /** Moves the clock forward; a negative step throws, time never runs backwards. Returns the new time. */
  advance(ms: number): Date;
  /** Jumps to `at` (forward or backward), e.g. to put two rows on the exact same millisecond. */
  set(at: Date): void;
}

/** A fixed default, so tests that do not care about the start still get the same timestamps on every run. */
export const FAKE_CLOCK_START = new Date('2026-01-15T09:00:00.000Z');

/**
 * A manual clock for code that receives `now: () => Date` (seed, services). For timers (presence grace) use
 * `vi.useFakeTimers()` instead; this clock only answers "what time is it".
 */
export function createFakeClock(start: Date = FAKE_CLOCK_START): FakeClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    nowMs: () => current,
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance() takes a finite, non-negative step.');
      current += ms;
      return new Date(current);
    },
    set(at) {
      current = at.getTime();
    },
  };
}
