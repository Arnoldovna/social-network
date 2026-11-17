import { Password } from '@app/shared';
import { eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import { argon2Hasher } from '../../shared/auth/password.js';
import { newAvatarKey } from '../../shared/media/media-url.js';
import type { ObjectStorage } from '../../shared/storage/object-storage.js';
import type { ProcessedAvatar } from '../../shared/uploads/process-image.js';
import type { Database } from '../client.js';
import { chatMessages, friendships, users, wallPosts } from '../schema/index.js';
import { pickAvatarDesign, renderAvatar } from './avatars.js';
import { mulberry32, planTimeline, SEED_RANDOM_SEED, type SeedTimeline } from './content.js';
import { DEMO_EMAIL, PEOPLE, type PersonHandle } from './people.js';

/**
 * Seed logic without side effects at import (DATA-MODEL.md, Seed plan; ADR-0019 §7), so `seed.int.test.ts` runs it
 * in-process against its own database and the fake storage. `cli.ts` is the only entry point.
 *
 * Insert-only and idempotent: when the demo user exists the run logs "already seeded" and writes nothing (B-63).
 * There is no reset; local data is reset with `docker compose --profile app down -v` and `pnpm dev:setup`.
 */

/**
 * Seeding needs `SEED_ALLOW=true` set explicitly for the invocation, whatever NODE_ENV is (conventions §8): the
 * compose `seed` service runs the production image with NODE_ENV=production, so NODE_ENV can never be the switch.
 * `SEED_ALLOW` is never an .env key. The message names the variable, never a value.
 */
export function assertSeedAllowed(env: Readonly<Record<string, string | undefined>>): void {
  if (env['SEED_ALLOW'] !== 'true') {
    throw new Error('seeding is disabled: set SEED_ALLOW=true for this invocation (pnpm db:seed does)');
  }
}

export interface SeedDeps {
  db: Database;
  /** Receives the generated avatars (`avatars/<id>/<uuid>.webp`). */
  storage: ObjectStorage;
  /** Password of every seeded account (SEED_DEMO_PASSWORD, 12 to 256 characters). Never logged. */
  password: string;
  logger: Pick<Logger, 'info'>;
  /** Seeded timestamps are relative to this instant, so the demo never looks stale. */
  now: () => Date;
}

export interface SeedCounts {
  users: number;
  friendships: number;
  posts: number;
  messages: number;
  avatars: number;
}

export type SeedOutcome = { status: 'seeded'; counts: SeedCounts } | { status: 'already-seeded' };

/**
 * Transaction-scoped advisory lock that serialises concurrent seed runs on one database (two `pnpm db:seed` at once,
 * or a host run next to the compose `seed` service): the second run waits for the first to commit, then finds the
 * demo user and writes nothing, instead of failing on `users_email_lower_idx`. The value is arbitrary but fixed.
 */
const SEED_LOCK_KEY = 20_261_115;

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function demoUserExists(db: Pick<Database, 'select'>): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
  return rows.length > 0;
}

/** One argon2id hash per account (each with its own salt), computed before the transaction opens. */
async function hashPasswords(password: string): Promise<string[]> {
  const hashes: string[] = [];
  // Sequential on purpose: each hash takes 64 MiB of memory, and a one-shot seed has no need for speed.
  while (hashes.length < PEOPLE.length) hashes.push(await argon2Hasher.hash(password));
  return hashes;
}

/** The avatars of the people who get one, rendered before the transaction opens (CPU work, no I/O). */
async function renderAvatars(random: () => number): Promise<Map<PersonHandle, ProcessedAvatar>> {
  const avatars = new Map<PersonHandle, ProcessedAvatar>();
  for (const person of PEOPLE) {
    if (person.avatar) avatars.set(person.handle, await renderAvatar(pickAvatarDesign(random)));
  }
  return avatars;
}

function idOf<K extends string>(ids: ReadonlyMap<K, number>, key: K): number {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`seed: ${key} was not inserted`);
  return id;
}

/**
 * Writes every row inside the caller's transaction, each table in chronological order, so identity ids and
 * `created_at` agree. Avatar objects are put before the commit: if a put fails, the transaction rolls back and the
 * next run starts over (an object a failed run already put stays unreferenced and is never served, ADR-0019 §7).
 */
async function insertAll(
  tx: Transaction,
  {
    timeline,
    hashes,
    avatars,
    storage,
  }: {
    timeline: SeedTimeline;
    hashes: readonly string[];
    avatars: ReadonlyMap<PersonHandle, ProcessedAvatar>;
    storage: ObjectStorage;
  },
): Promise<SeedCounts> {
  const inserted = await tx
    .insert(users)
    .values(
      timeline.users.map(({ person, createdAt }, index) => {
        const passwordHash = hashes[index];
        if (passwordHash === undefined) throw new Error('seed: a password hash is missing');
        const { firstName, lastName, email, bio } = person;
        return { firstName, lastName, email, bio, passwordHash, createdAt, updatedAt: createdAt };
      }),
    )
    .returning({ id: users.id, email: users.email });
  const idByEmail = new Map(inserted.map((row) => [row.email, row.id]));
  const ids = new Map(timeline.users.map(({ person }) => [person.handle, idOf(idByEmail, person.email)]));

  await tx.insert(friendships).values(
    timeline.friendships.map(({ requester, addressee, status, createdAt, acceptedAt }) => ({
      requesterId: idOf(ids, requester),
      addresseeId: idOf(ids, addressee),
      status,
      createdAt,
      acceptedAt,
    })),
  );

  await tx.insert(wallPosts).values(
    timeline.posts.map(({ wallOwner, author, body, createdAt }) => ({
      wallOwnerId: idOf(ids, wallOwner),
      authorId: idOf(ids, author),
      body,
      createdAt,
    })),
  );

  await tx
    .insert(chatMessages)
    .values(timeline.messages.map(({ author, body, createdAt }) => ({ authorId: idOf(ids, author), body, createdAt })));

  const uploads = timeline.users.flatMap(({ person, createdAt }) => {
    const avatar = avatars.get(person.handle);
    if (!avatar) return [];
    const id = idOf(ids, person.handle);
    return [{ id, createdAt, avatar, avatarKey: newAvatarKey(id) }];
  });
  // All puts at once and before the key updates, so the open transaction waits for one storage round trip instead of
  // alternating S3 and Postgres for every avatar while it holds its locks.
  await Promise.all(uploads.map(({ avatarKey, avatar }) => storage.put(avatarKey, avatar.buffer, avatar.contentType)));
  for (const { id, createdAt, avatarKey } of uploads) {
    // `updatedAt` explicitly, or `$onUpdate` would stamp the wall-clock time instead of the seeded timeline.
    await tx.update(users).set({ avatarKey, updatedAt: createdAt }).where(eq(users.id, id));
  }

  return {
    users: inserted.length,
    friendships: timeline.friendships.length,
    posts: timeline.posts.length,
    messages: timeline.messages.length,
    avatars: avatars.size,
  };
}

/**
 * Seeds the demo (F-115): 14 people, the friendship graph, wall posts, the shared chat and generated avatars, all in
 * one transaction. Skips without writing anything when the demo user exists (B-63). Password hashing and avatar
 * rendering happen before the transaction, so it stays open only for the inserts and the avatar puts.
 */
export async function runSeed({ db, storage, password, logger, now }: SeedDeps): Promise<SeedOutcome> {
  // The same rule as registration (F-09); checked here too because tests and future callers bypass cli.ts.
  if (!Password.safeParse(password).success) {
    throw new RangeError('seed: the demo password must be 12 to 256 characters (SEED_DEMO_PASSWORD)');
  }

  const alreadySeeded = (): SeedOutcome => {
    logger.info({ demoEmail: DEMO_EMAIL }, 'already seeded');
    return { status: 'already-seeded' };
  };
  if (await demoUserExists(db)) return alreadySeeded();

  const random = mulberry32(SEED_RANDOM_SEED);
  const timeline = planTimeline(now(), random);
  const hashes = await hashPasswords(password);
  const avatars = await renderAvatars(random);

  const counts = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SEED_LOCK_KEY})`);
    // Re-checked under the lock: a concurrent run may have committed since the check above.
    if (await demoUserExists(tx)) return undefined;
    return insertAll(tx, { timeline, hashes, avatars, storage });
  });
  if (!counts) return alreadySeeded();

  logger.info({ ...counts, demoEmail: DEMO_EMAIL }, 'seeded demo data');
  return { status: 'seeded', counts };
}
