import { CHAT_MAX, PAGE_LIMIT_DEFAULT, POST_MAX } from '@app/shared';
import { asc, count } from 'drizzle-orm';
import type { Logger } from 'pino';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { currentDatabaseUrl } from '../../../../test/database.js';
import { createFakeStorage, type FakeStorage } from '../../../../test/fakes.js';
import { argon2Hasher } from '../../../shared/auth/password.js';
import { createLogger } from '../../../shared/logging/logger.js';
import { parseAvatarKey } from '../../../shared/media/media-url.js';
import { createDatabase, type DatabaseHandle } from '../../client.js';
import { chatMessages, friendships, users, wallPosts } from '../../schema/index.js';
import { AVATAR_COMPOSITIONS, AVATAR_PALETTE, pickAvatarDesign, renderAvatarSvg } from '../avatars.js';
import { CHAT, FRIENDSHIPS, mulberry32, planTimeline, SEED_RANDOM_SEED, SEED_SPAN_DAYS, WALLS } from '../content.js';
import { assertSeedAllowed, runSeed, type SeedOutcome } from '../index.js';
import { DEMO_EMAIL, PEOPLE, type PersonHandle } from '../people.js';

/**
 * The demo seed (F-115, B-63; DATA-MODEL.md Seed plan, ADR-0019 §7) in-process against this file's own clone of the
 * migrated template database, with the in-memory object storage. The `runSeed` tests are steps of one story on that
 * database and run in file order: a failed run leaves nothing, two racing runs seed once, the result is checked, and
 * a further run writes nothing.
 */

const NOW = new Date('2026-11-15T12:00:00.000Z');
const DAY_MS = 86_400_000;
const WINDOW_START = NOW.getTime() - SEED_SPAN_DAYS * DAY_MS;
const PASSWORD = 'seed integration password';

const EMPTY = { users: 0, friendships: 0, posts: 0, messages: 0 };
const SEEDED = { users: 14, friendships: 13, posts: 41, messages: 46 };

const LogLine = z.object({ msg: z.string() });

function capturingLogger(): { logger: Logger; lines: string[]; messages: () => string[] } {
  const lines: string[] = [];
  const logger = createLogger(
    { LOG_LEVEL: 'info', NODE_ENV: 'test' },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );
  return { logger, lines, messages: () => lines.map((line) => LogLine.parse(JSON.parse(line)).msg) };
}

const friendsOf = (handle: PersonHandle): Set<PersonHandle> =>
  new Set(
    FRIENDSHIPS.filter((f) => f.status === 'accepted' && (f.requester === handle || f.addressee === handle)).map((f) =>
      f.requester === handle ? f.addressee : f.requester,
    ),
  );

const isAscending = (times: readonly Date[]): boolean =>
  times.every((time, index) => index === 0 || time.getTime() >= (times[index - 1]?.getTime() ?? 0));

describe('assertSeedAllowed', () => {
  it('passes only when SEED_ALLOW is exactly "true", whatever NODE_ENV says', () => {
    expect(() => {
      assertSeedAllowed({ SEED_ALLOW: 'true', NODE_ENV: 'production' });
    }).not.toThrow();
    expect(() => {
      assertSeedAllowed({ NODE_ENV: 'development' });
    }).toThrow(/SEED_ALLOW=true/);
  });

  it.each([undefined, '', 'false', '1', 'TRUE', 'yes', ' true'])('refuses SEED_ALLOW=%j', (value) => {
    expect(() => {
      assertSeedAllowed({ SEED_ALLOW: value, NODE_ENV: 'test' });
    }).toThrow('seeding is disabled: set SEED_ALLOW=true for this invocation (pnpm db:seed does)');
  });
});

describe('seed content', () => {
  const timeline = planTimeline(NOW, mulberry32(SEED_RANDOM_SEED));

  it('is deterministic for the same "now" and the same seed', () => {
    expect(planTimeline(NOW, mulberry32(SEED_RANDOM_SEED))).toEqual(timeline);
    const designs = (random: () => number) => Array.from({ length: 10 }, () => pickAvatarDesign(random));
    expect(designs(mulberry32(SEED_RANDOM_SEED))).toEqual(designs(mulberry32(SEED_RANDOM_SEED)));
  });

  it('has 14 people with unique lower-case example.com emails, four without avatar and two without bio', () => {
    expect(PEOPLE).toHaveLength(14);
    expect(DEMO_EMAIL).toBe('mira.novak@example.com');
    expect(new Set(PEOPLE.map((p) => p.email)).size).toBe(14);
    expect(new Set(PEOPLE.map((p) => p.handle)).size).toBe(14);
    for (const person of PEOPLE) expect(person.email).toMatch(/^[a-z]+\.[a-z]+@example\.com$/);
    expect(PEOPLE.filter((p) => !p.avatar).map((p) => p.handle)).toEqual(['noah', 'mateo', 'clara', 'hannah']);
    expect(PEOPLE.filter((p) => p.bio === null).map((p) => p.handle)).toEqual(['mateo', 'hannah']);
  });

  it('shows every friendship state from Mira’s point of view', () => {
    const fromMira = (state: 'friends' | 'incoming' | 'outgoing') =>
      FRIENDSHIPS.filter((f) => {
        if (state === 'friends') return f.status === 'accepted' && (f.requester === 'mira' || f.addressee === 'mira');
        if (state === 'incoming') return f.status === 'pending' && f.addressee === 'mira';
        return f.status === 'pending' && f.requester === 'mira';
      })
        .map((f) => (f.requester === 'mira' ? f.addressee : f.requester))
        .sort();
    expect(fromMira('friends')).toEqual(['aiko', 'amara', 'jonas', 'priya', 'tomas']);
    expect(fromMira('incoming')).toEqual(['sofia', 'yusuf']);
    expect(fromMira('outgoing')).toEqual(['clara']);
    const pairs = FRIENDSHIPS.map((f) => [f.requester, f.addressee].sort().join(':'));
    expect(new Set(pairs).size).toBe(pairs.length); // one row per unordered pair (friendships_pair_idx)
    expect(FRIENDSHIPS.every((f) => f.requester !== f.addressee)).toBe(true);
  });

  it('only lets owners and their friends write on a wall, with 14 posts on Mira’s and 3 to 9 on her friends’', () => {
    for (const { owner, posts } of WALLS) {
      const allowed = new Set([owner, ...friendsOf(owner)]);
      for (const post of posts) expect(allowed, `${post.author} on ${owner}'s wall`).toContain(post.author);
    }
    const sizes = new Map(WALLS.map((wall) => [wall.owner, wall.posts.length]));
    expect(sizes.get('mira')).toBe(14);
    for (const friend of friendsOf('mira')) {
      expect(sizes.get(friend)).toBeGreaterThanOrEqual(3);
      expect(sizes.get(friend)).toBeLessThanOrEqual(9);
    }
  });

  it('has more than two chat pages, and only trimmed texts within the limits, without emoji or filler', () => {
    expect(CHAT).toHaveLength(46);
    expect(CHAT.length).toBeGreaterThan(2 * PAGE_LIMIT_DEFAULT);
    const texts = [
      ...CHAT.map((m) => ({ body: m.body, max: CHAT_MAX })),
      ...WALLS.flatMap((w) => w.posts.map((p) => ({ body: p.body, max: POST_MAX }))),
      ...PEOPLE.flatMap((p) => (p.bio === null ? [] : [{ body: p.bio, max: 1000 }])),
    ];
    for (const { body, max } of texts) {
      expect(body).toBe(body.trim());
      expect(body.length).toBeGreaterThan(0);
      expect(body.length).toBeLessThanOrEqual(max);
      expect(body).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(body).not.toMatch(/lorem|ipsum|jane doe/i);
    }
  });

  it('dates everything inside the last 42 days, in chronological order per table', () => {
    const all = [
      ...timeline.users.map((u) => u.createdAt),
      ...timeline.friendships.flatMap((f) => (f.acceptedAt ? [f.createdAt, f.acceptedAt] : [f.createdAt])),
      ...timeline.posts.map((p) => p.createdAt),
      ...timeline.messages.map((m) => m.createdAt),
    ];
    for (const time of all) {
      expect(time.getTime()).toBeGreaterThanOrEqual(WINDOW_START);
      expect(time.getTime()).toBeLessThan(NOW.getTime());
    }
    expect(isAscending(timeline.users.map((u) => u.createdAt))).toBe(true);
    expect(isAscending(timeline.friendships.map((f) => f.createdAt))).toBe(true);
    expect(isAscending(timeline.posts.map((p) => p.createdAt))).toBe(true);
    expect(isAscending(timeline.messages.map((m) => m.createdAt))).toBe(true);
    expect(timeline.users.map((u) => u.person.handle)).toEqual(PEOPLE.map((p) => p.handle));
    expect(timeline.messages.map((m) => m.body)).toEqual(CHAT.map((m) => m.body));
  });

  it('accepts friendships after both accounts exist and before any post between the two', () => {
    const joined = new Map(timeline.users.map((u) => [u.person.handle, u.createdAt.getTime()]));
    const lastJoined = Math.max(...joined.values());
    for (const friendship of timeline.friendships) {
      expect(friendship.createdAt.getTime()).toBeGreaterThan(lastJoined);
      if (friendship.status === 'accepted') {
        expect(friendship.acceptedAt?.getTime()).toBeGreaterThan(friendship.createdAt.getTime());
      } else {
        expect(friendship.acceptedAt).toBeNull();
      }
    }
    const lastAccepted = Math.max(...timeline.friendships.map((f) => f.acceptedAt?.getTime() ?? 0));
    for (const post of timeline.posts) expect(post.createdAt.getTime()).toBeGreaterThan(lastAccepted);
  });

  it('draws avatars as flat rectangles in palette colours only', () => {
    const random = mulberry32(SEED_RANDOM_SEED);
    const palette = new Set<string>(Object.values(AVATAR_PALETTE));
    for (let index = 0; index < 50; index++) {
      const design = pickAvatarDesign(random);
      expect(AVATAR_COMPOSITIONS).toContain(design.composition);
      expect(new Set(design.colours).size).toBe(3);
      const svg = renderAvatarSvg(design);
      const elements = [...svg.matchAll(/<(\w+)/g)].map((match) => match[1]);
      expect(new Set(elements)).toEqual(new Set(['svg', 'rect']));
      for (const [, fill] of svg.matchAll(/fill="([^"]+)"/g)) expect(palette).toContain(fill);
    }
  });
});

describe('runSeed', () => {
  let database: DatabaseHandle;
  /** The storage of the run that seeded; later steps check its objects. */
  let seededStorage: FakeStorage;
  const log = capturingLogger();

  const seed = (storage: FakeStorage, password = PASSWORD): Promise<SeedOutcome> =>
    runSeed({ db: database.db, storage, password, logger: log.logger, now: () => new Date(NOW) });

  async function rowCounts(): Promise<typeof EMPTY> {
    const total = async (table: typeof users | typeof friendships | typeof wallPosts | typeof chatMessages) => {
      const [row] = await database.db.select({ n: count() }).from(table);
      return row?.n ?? 0;
    };
    return {
      users: await total(users),
      friendships: await total(friendships),
      posts: await total(wallPosts),
      messages: await total(chatMessages),
    };
  }

  const snapshot = async () => ({
    users: await database.db.select().from(users).orderBy(asc(users.id)),
    friendships: await database.db.select().from(friendships).orderBy(asc(friendships.id)),
    posts: await database.db.select().from(wallPosts).orderBy(asc(wallPosts.id)),
    messages: await database.db.select().from(chatMessages).orderBy(asc(chatMessages.id)),
  });

  beforeAll(() => {
    database = createDatabase(currentDatabaseUrl(), {
      logger: createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' }),
    });
  });

  afterAll(async () => {
    await database.close();
  });

  it('refuses a demo password shorter than 12 characters before touching the database', async () => {
    await expect(seed(createFakeStorage(), 'short')).rejects.toThrow(/12 to 256 characters/);
    expect(await rowCounts()).toEqual(EMPTY);
  });

  it('rolls the whole run back when an avatar put fails, so the next run starts over', async () => {
    const storage = createFakeStorage();
    storage.fail('put', new Error('storage is down'));
    await expect(seed(storage)).rejects.toThrow('storage is down');
    expect(await rowCounts()).toEqual(EMPTY);
    expect(storage.objects.size).toBe(0);
  });

  it('seeds exactly once when two runs race (advisory lock, no unique violation)', async () => {
    const first = createFakeStorage();
    const second = createFakeStorage();
    const [firstOutcome, secondOutcome] = await Promise.all([seed(first), seed(second)]);

    expect([firstOutcome.status, secondOutcome.status].sort()).toEqual(['already-seeded', 'seeded']);
    const seeded = firstOutcome.status === 'seeded' ? firstOutcome : secondOutcome;
    expect(seeded).toEqual({ status: 'seeded', counts: { ...SEEDED, avatars: 10 } });
    seededStorage = seeded === firstOutcome ? first : second;
    const skippedStorage = seededStorage === first ? second : first;
    expect(seededStorage.objects.size).toBe(10);
    expect(skippedStorage.objects.size).toBe(0);
    expect(await rowCounts()).toEqual(SEEDED);
  });

  it('stores the 14 accounts with their own argon2id hash of the demo password and no plain text', async () => {
    const rows = await database.db.select().from(users).orderBy(asc(users.id));
    expect(rows.map((row) => row.email)).toEqual(PEOPLE.map((person) => person.email));
    expect(rows.map((row) => row.bio)).toEqual(PEOPLE.map((person) => person.bio));
    expect(rows[0]).toMatchObject({ email: DEMO_EMAIL, firstName: 'Mira', lastName: 'Novak' });

    expect(new Set(rows.map((row) => row.passwordHash)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
      expect(row.passwordHash).not.toContain(PASSWORD);
      expect(argon2Hasher.needsRehash(row.passwordHash)).toBe(false);
      expect(await argon2Hasher.verify(row.passwordHash, PASSWORD)).toBe(true);
    }
  });

  it('gives ten people a generated 512 × 512 WebP avatar under their own server-made key', async () => {
    const rows = await database.db.select().from(users).orderBy(asc(users.id));
    const withAvatar = rows.filter((row) => row.avatarKey !== null);
    expect(withAvatar.map((row) => row.email)).toEqual(PEOPLE.filter((p) => p.avatar).map((p) => p.email));
    expect(new Set(seededStorage.objects.keys())).toEqual(new Set(withAvatar.map((row) => row.avatarKey)));

    for (const row of withAvatar) {
      expect(parseAvatarKey(row.avatarKey ?? '')?.userId).toBe(row.id);
      const object = seededStorage.objects.get(row.avatarKey ?? '');
      expect(object?.contentType).toBe('image/webp');
      const metadata = await sharp(object?.body).metadata();
      expect(metadata).toMatchObject({ format: 'webp', width: 512, height: 512 });
      expect(metadata.exif).toBeUndefined();
      // The avatar update keeps the seeded timeline instead of the wall-clock time.
      expect(row.updatedAt).toEqual(row.createdAt);
    }
  });

  it('writes the friendship graph, the walls and the chat as planned', async () => {
    const people = await database.db.select({ id: users.id, email: users.email }).from(users);
    const handleOf = new Map(
      people.map((row) => [row.id, PEOPLE.find((person) => person.email === row.email)?.handle]),
    );
    const rows = await database.db.select().from(friendships).orderBy(asc(friendships.id));
    const stored = rows.map((row) => ({
      requester: handleOf.get(row.requesterId),
      addressee: handleOf.get(row.addresseeId),
      status: row.status,
    }));
    expect(new Set(stored.map((f) => JSON.stringify(f)))).toEqual(new Set(FRIENDSHIPS.map((f) => JSON.stringify(f))));

    const posts = await database.db.select().from(wallPosts);
    for (const { owner, posts: planned } of WALLS) {
      const onWall = posts.filter((post) => handleOf.get(post.wallOwnerId) === owner).sort((a, b) => a.id - b.id);
      expect(onWall.map((post) => [handleOf.get(post.authorId), post.body])).toEqual(
        planned.map((post) => [post.author, post.body]),
      );
    }

    const messages = await database.db.select().from(chatMessages).orderBy(asc(chatMessages.id));
    expect(messages.map((message) => [handleOf.get(message.authorId), message.body])).toEqual(
      CHAT.map((message) => [message.author, message.body]),
    );
  });

  it('dates every row inside the last 42 days, with ids in the same order as created_at', async () => {
    const { users: userRows, friendships: friendshipRows, posts, messages } = await snapshot();
    for (const rows of [userRows, friendshipRows, posts, messages]) {
      const times = rows.map((row) => row.createdAt);
      expect(isAscending(times)).toBe(true);
      for (const time of times) {
        expect(time.getTime()).toBeGreaterThanOrEqual(WINDOW_START);
        expect(time.getTime()).toBeLessThan(NOW.getTime());
      }
    }
  });

  it('logs the outcome without the demo password', () => {
    expect(log.messages()).toEqual(expect.arrayContaining(['seeded demo data', 'already seeded']));
    for (const line of log.lines) expect(line).not.toContain(PASSWORD);
  });

  it('B-63: a second run on a seeded database writes nothing and succeeds', async () => {
    const before = await snapshot();
    const storage = createFakeStorage();
    log.lines.length = 0;

    await expect(seed(storage)).resolves.toEqual({ status: 'already-seeded' });

    expect(await snapshot()).toEqual(before);
    expect(storage.objects.size).toBe(0);
    expect(log.messages()).toEqual(['already seeded']);
  });
});
