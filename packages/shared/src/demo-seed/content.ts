import { type DemoPerson, PEOPLE, type PersonHandle } from './people.js';

/**
 * What the demo shows (DATA-MODEL.md, Seed plan): the friendship graph, the wall posts, the shared chat and the
 * timeline that dates all of it. Pure data and pure functions, written by the API seed (apps/api/src/db/seed) and by
 * the GitHub Pages demo (apps/web/src/demo, ADR-0020). No lorem ipsum, no "Jane Doe", no emoji (maw anti-AI
 * checklist). Every text is trimmed and within the table's length check.
 */

// ---------------------------------------------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------------------------------------------

/** A source of uniformly distributed numbers in [0, 1). */
export type Random = () => number;

/** The seed of the demo's PRNG, fixed so screenshots are reproducible (DATA-MODEL.md). */
export const SEED_RANDOM_SEED = 20_261_115;

/**
 * mulberry32: a tiny 32-bit PRNG. Not cryptographic, and it does not need to be: it only picks avatar compositions
 * and timestamps, and the same seed must give the same demo on every machine.
 */
export function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** An element of a non-empty list, chosen by `random`. */
export function pick<T>(items: readonly T[], random: Random): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new RangeError('pick() needs a non-empty list.');
  return item;
}

// ---------------------------------------------------------------------------------------------------------------
// Friendship graph
// ---------------------------------------------------------------------------------------------------------------

export interface SeedFriendship {
  /** Whoever asked first (DATA-MODEL.md: one row per unordered pair). */
  readonly requester: PersonHandle;
  readonly addressee: PersonHandle;
  readonly status: 'pending' | 'accepted';
}

/**
 * From Mira's point of view every state is visible: five friends, two incoming requests (the nav badge shows 2), one
 * outgoing request and five people without a relation (search and "add friend"). A small mesh among the others keeps
 * their walls readable when logging in as them.
 */
export const FRIENDSHIPS: readonly SeedFriendship[] = [
  { requester: 'tomas', addressee: 'mira', status: 'accepted' },
  { requester: 'mira', addressee: 'aiko', status: 'accepted' },
  { requester: 'priya', addressee: 'mira', status: 'accepted' },
  { requester: 'mira', addressee: 'jonas', status: 'accepted' },
  { requester: 'amara', addressee: 'mira', status: 'accepted' },
  { requester: 'tomas', addressee: 'aiko', status: 'accepted' },
  { requester: 'priya', addressee: 'jonas', status: 'accepted' },
  { requester: 'amara', addressee: 'ewa', status: 'accepted' },
  { requester: 'daniel', addressee: 'noah', status: 'accepted' },
  { requester: 'sofia', addressee: 'ewa', status: 'accepted' },
  { requester: 'sofia', addressee: 'mira', status: 'pending' },
  { requester: 'yusuf', addressee: 'mira', status: 'pending' },
  { requester: 'mira', addressee: 'clara', status: 'pending' },
];

// ---------------------------------------------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------------------------------------------

export interface SeedPost {
  readonly author: PersonHandle;
  readonly body: string;
}

export interface SeedWall {
  readonly owner: PersonHandle;
  /** Oldest first. */
  readonly posts: readonly SeedPost[];
}

/**
 * Walls are friends-only (ADR-0011): every author is the owner or an accepted friend of the owner. Mira's wall has
 * 14 posts, each of her friends' walls 3 to 9.
 */
export const WALLS: readonly SeedWall[] = [
  {
    owner: 'mira',
    posts: [
      { author: 'mira', body: 'Finished the risograph run for the zine. 120 copies, two colours, one paper jam.' },
      { author: 'tomas', body: 'Saving you a loaf on Friday. Rye this time, Gil is in a sour mood.' },
      {
        author: 'mira',
        body: 'Anyone up for the Saturday ride along the Elster? Leaving 10:00 from the Konnewitz bridge.',
      },
      {
        author: 'priya',
        body: 'Count me in for the ride. I will bring the thermos and the complaints about cobblestones.',
      },
      { author: 'jonas', body: 'The shelf for your prints is glued and clamped. Pick it up any evening this week.' },
      { author: 'mira', body: 'New bike light, finally. The old one had two modes: off and almost off.' },
      { author: 'aiko', body: 'Thanks for the feedback on the ampersands. Version four is less dramatic.' },
      {
        author: 'amara',
        body: 'The plant cutting you gave me has three new leaves. It clearly likes the north window.',
      },
      { author: 'mira', body: 'Spent the evening fixing a focus outline nobody but me will notice. Worth it.' },
      {
        author: 'tomas',
        body: 'Recorded the street musicians at the market today. The accordion player wants a copy.',
      },
      {
        author: 'mira',
        body: 'Swapped three zines at the print fair and came home with five. The maths works out somehow.',
      },
      {
        author: 'priya',
        body: 'Made a chart of how often the tram is late on your street. You do not want to see it.',
      },
      { author: 'jonas', body: 'Measured twice, cut once, still had to sand for an hour. The frame fits now.' },
      { author: 'mira', body: 'Planning a small print exhibition in the stairwell. Bring one piece, take one piece.' },
    ],
  },
  {
    owner: 'tomas',
    posts: [
      { author: 'tomas', body: 'Gil survived the heatwave. Bread on Friday for whoever brings jam.' },
      { author: 'mira', body: 'Bringing apricot jam. The good one from the market, not the one I made.' },
      { author: 'aiko', body: 'Your bread made the studio smell like a bakery all afternoon. Thank you.' },
      { author: 'tomas', body: 'Mixing a podcast with a lot of coffee cup noises. Someone please stop stirring.' },
      { author: 'tomas', body: 'Tried a spelt loaf. Dense enough to use as a doorstop, tasty enough to eat anyway.' },
      { author: 'mira', body: 'The doorstop loaf was great with soup. Do it again.' },
    ],
  },
  {
    owner: 'aiko',
    posts: [
      {
        author: 'aiko',
        body: "Lecture notes from yesterday's type talk are on my profile. The ampersand section is long.",
      },
      { author: 'mira', body: 'The ampersand section was the best part. Please never shorten it.' },
      { author: 'tomas', body: 'Could you draw a sign for the bread stand? Payment in loaves.' },
      { author: 'aiko', body: 'Kerning the lowercase until two in the morning. The letter g is winning.' },
      { author: 'aiko', body: "Printed the specimen sheet on Mira's risograph. Pink and blue suit the italics." },
    ],
  },
  {
    owner: 'priya',
    posts: [
      { author: 'priya', body: 'Published the piece on bus delays. Line 89 is the champion, sadly.' },
      { author: 'mira', body: 'The map in your article is great. Showed it to the whole office.' },
      { author: 'jonas', body: 'Line 89 is my line. Now I finally have proof for my boss.' },
      { author: 'priya', body: 'Spent the day cleaning a spreadsheet with four different date formats.' },
      { author: 'priya', body: 'Looking for people who cycle to work in winter for a short interview.' },
      { author: 'jonas', body: 'I cycle all winter. Happy to talk, as long as you bring coffee.' },
      { author: 'mira', body: 'Me too. Ask me about the ice on the bridge by the canal.' },
    ],
  },
  {
    owner: 'jonas',
    posts: [
      { author: 'jonas', body: 'First pull request merged. It was a typo fix, but it counts.' },
      { author: 'priya', body: 'It absolutely counts. Congratulations.' },
      { author: 'mira', body: 'Next step: the bug that only happens on Fridays.' },
      { author: 'jonas', body: 'Built a workbench out of the old kitchen table. It wobbles less than my code.' },
    ],
  },
  {
    owner: 'amara',
    posts: [
      { author: 'amara', body: 'Thanks for the plant cutting. It has already outgrown the pot.' },
      { author: 'ewa', body: 'I have a pot for that. Slightly wonky, glazed in green.' },
      { author: 'amara', body: 'Sunday market haul: two ferns, one lemon tree, zero self-control.' },
      { author: 'mira', body: 'Can I visit the lemon tree? I will bring prints for the walls.' },
      { author: 'amara', body: 'The site visit was in the rain again. The new library roof is finally closed.' },
    ],
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------------------------------------------

export interface SeedMessage {
  readonly author: PersonHandle;
  readonly body: string;
}

/**
 * The shared chat room, oldest first: 46 messages over six weeks, so "load older messages" is demonstrable with a
 * page size of 20. The room is global (ADR-0011), so anyone may write.
 */
export const CHAT: readonly SeedMessage[] = [
  { author: 'daniel', body: 'Board games on Thursday, who is in?' },
  { author: 'tomas', body: 'Bringing Carcassonne and the bad expansion.' },
  { author: 'priya', body: 'The one with the river? Fine, but I keep score.' },
  { author: 'mira', body: 'I can come after eight.' },
  { author: 'clara', body: 'Is the Karl-Heine bakery open on Sundays?' },
  { author: 'tomas', body: 'Only until noon.' },
  { author: 'clara', body: 'Thanks. Early croissants it is.' },
  { author: 'hannah', body: 'Reminder: the library swaps books on the first of the month.' },
  { author: 'aiko', body: 'Does anyone have a spare A3 cutting mat?' },
  { author: 'jonas', body: 'I have two. Pick one up at the workshop.' },
  { author: 'noah', body: 'Climbing gym on Wednesday evening, two spots left in the car.' },
  { author: 'daniel', body: 'Take me, I need to stretch after marking forty tests.' },
  { author: 'yusuf', body: 'The bees made their first honey of the year. Small jars for anyone who wants one.' },
  { author: 'ewa', body: 'I will trade a cup for a jar.' },
  { author: 'yusuf', body: 'Deal. Wonky cups are the best cups.' },
  { author: 'sofia', body: 'Drawing the staircase at number 12 on Josephstrasse this weekend, come and watch.' },
  { author: 'amara', body: 'That staircase is from 1904. Look at the handrail.' },
  { author: 'mateo', body: 'Has anyone seen a grey cat with a red collar near the park?' },
  { author: 'hannah', body: 'There was one sitting on the post boxes this morning.' },
  { author: 'mateo', body: 'That is him. Thank you, he is home now.' },
  { author: 'priya', body: 'Tram 11 is replaced by buses all week. Plan an extra twenty minutes.' },
  { author: 'mira', body: 'Thanks for the warning. The bike it is.' },
  { author: 'daniel', body: 'Thursday again: we are trying a new game, the rules are eight pages long.' },
  { author: 'tomas', body: 'I will read them. Probably.' },
  { author: 'clara', body: 'Looking for a French conversation partner, I can offer German or English in return.' },
  { author: 'aiko', body: 'I would love that. My French stops at ordering coffee.' },
  { author: 'jonas', body: 'Free oak offcuts at the workshop. Good for small shelves or chopping boards.' },
  { author: 'ewa', body: 'Could you save me some? I need boards for drying cups.' },
  { author: 'noah', body: 'Pub quiz on Tuesday. We need someone who knows music.' },
  { author: 'tomas', body: 'Sound engineer reporting for duty.' },
  { author: 'sofia', body: 'The zine fair is next Saturday at the old tram depot.' },
  { author: 'mira', body: 'I will have a table there. Come and say hello.' },
  { author: 'yusuf', body: 'Is anyone else confused by the new recycling schedule?' },
  { author: 'hannah', body: 'The paper bin is now on Mondays. The flyer was printed grey on grey.' },
  { author: 'priya', body: 'I will make a chart.' },
  { author: 'daniel', body: 'Thursday winner: Amara, by a lot.' },
  { author: 'amara', body: 'Years of reading floor plans. The board is just a small building.' },
  { author: 'clara', body: 'Lost a blue scarf at the zine fair. Has anyone seen it?' },
  { author: 'sofia', body: 'It is at the depot office, they keep a box for lost things.' },
  { author: 'jonas', body: 'Workshop open day on Saturday. Bring a piece of wood, leave with a spoon.' },
  { author: 'mira', body: 'Can I pin up the flyer for the stairwell exhibition there?' },
  { author: 'jonas', body: 'Of course, next to the door.' },
  { author: 'noah', body: 'Map walk through the old harbour on Sunday morning, about two hours.' },
  { author: 'ewa', body: 'Count me in if it ends near a bakery.' },
  { author: 'tomas', body: 'It ends near mine. Bread is ready at eleven.' },
  { author: 'daniel', body: 'Board games on Thursday as always. New people welcome.' },
];

// ---------------------------------------------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Everything is dated within the last 42 days before "now", so the demo never looks stale (DATA-MODEL.md). */
export const SEED_SPAN_DAYS = 42;

/**
 * Phases of the timeline in days after its start. Accounts come first, accepted friendships after both accounts
 * exist and at least one day before the first wall post (walls are friends-only), open requests in the last week.
 * The newest row is half an hour old, so nothing is dated in the future even when the clock moves on.
 */
const ACCOUNTS = { from: 0, to: 2 } as const;
const ACCEPTED_REQUESTS = { from: 2, to: 8 } as const;
const ACCEPT_DELAY_MS = { min: HOUR_MS, max: 3 * DAY_MS } as const;
const OPEN_REQUESTS = { from: 35, to: 41 } as const;
const WALL_POSTS_FROM_DAY = 12;
const CHAT_FROM_DAY = 2;
const NEWEST_ROW_AGE_MS = 30 * MINUTE_MS;

export interface PlannedUser {
  readonly person: DemoPerson;
  readonly createdAt: Date;
}

export interface PlannedFriendship extends SeedFriendship {
  readonly createdAt: Date;
  /** Set exactly when the friendship is accepted (`friendships_accepted_at_chk`). */
  readonly acceptedAt: Date | null;
}

export interface PlannedPost extends SeedPost {
  readonly wallOwner: PersonHandle;
  readonly createdAt: Date;
}

export interface PlannedMessage extends SeedMessage {
  readonly createdAt: Date;
}

/** Every row with its timestamps, each list in chronological order (the order of insertion). */
export interface SeedTimeline {
  readonly users: readonly PlannedUser[];
  readonly friendships: readonly PlannedFriendship[];
  readonly posts: readonly PlannedPost[];
  readonly messages: readonly PlannedMessage[];
}

/** `count` instants in [fromMs, toMs), ascending, on whole seconds (timestamps that read naturally in the UI). */
function sortedInstants(count: number, fromMs: number, toMs: number, random: Random): Date[] {
  return Array.from({ length: count }, () => fromMs + random() * (toMs - fromMs))
    .map((ms) => Math.floor(ms / 1000) * 1000)
    .sort((a, b) => a - b)
    .map((ms) => new Date(ms));
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError(`no item at index ${String(index)}`);
  return item;
}

const byCreatedAt = (a: { createdAt: Date }, b: { createdAt: Date }): number =>
  a.createdAt.getTime() - b.createdAt.getTime();

/**
 * Dates every seeded row relative to `now`. The same `now` and the same `random` state give the same timeline. Rows
 * of one table come back sorted by `createdAt`, so inserting them in list order makes identity ids and `created_at`
 * agree (DATA-MODEL.md).
 */
export function planTimeline(now: Date, random: Random): SeedTimeline {
  const start = now.getTime() - SEED_SPAN_DAYS * DAY_MS;
  const end = now.getTime() - NEWEST_ROW_AGE_MS;
  const day = (offset: number): number => start + offset * DAY_MS;

  const accountTimes = sortedInstants(PEOPLE.length, day(ACCOUNTS.from), day(ACCOUNTS.to), random);
  const users = PEOPLE.map((person, index) => ({ person, createdAt: at(accountTimes, index) }));

  const accepted = FRIENDSHIPS.filter((friendship) => friendship.status === 'accepted');
  const open = FRIENDSHIPS.filter((friendship) => friendship.status === 'pending');
  const acceptedTimes = sortedInstants(accepted.length, day(ACCEPTED_REQUESTS.from), day(ACCEPTED_REQUESTS.to), random);
  const openTimes = sortedInstants(open.length, day(OPEN_REQUESTS.from), day(OPEN_REQUESTS.to), random);
  const friendships = [
    ...accepted.map((friendship, index) => {
      const createdAt = at(acceptedTimes, index);
      const delay = ACCEPT_DELAY_MS.min + random() * (ACCEPT_DELAY_MS.max - ACCEPT_DELAY_MS.min);
      return {
        ...friendship,
        createdAt,
        acceptedAt: new Date(Math.floor((createdAt.getTime() + delay) / 1000) * 1000),
      };
    }),
    ...open.map((friendship, index) => ({ ...friendship, createdAt: at(openTimes, index), acceptedAt: null })),
  ].sort(byCreatedAt);

  const posts = WALLS.flatMap(({ owner, posts: wall }) => {
    const times = sortedInstants(wall.length, day(WALL_POSTS_FROM_DAY), end, random);
    return wall.map((post, index) => ({ ...post, wallOwner: owner, createdAt: at(times, index) }));
  }).sort(byCreatedAt);

  const chatTimes = sortedInstants(CHAT.length, day(CHAT_FROM_DAY), end, random);
  const messages = CHAT.map((message, index) => ({ ...message, createdAt: at(chatTimes, index) }));

  return { users, friendships, posts, messages };
}
