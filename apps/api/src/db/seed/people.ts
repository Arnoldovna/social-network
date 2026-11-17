/**
 * The 14 fictional demo people (DATA-MODEL.md, Seed plan). No real persons, nothing from the legacy database. Emails
 * use the reserved `example.com` domain and are stored lower case (`users_email_lowercase_chk`). The order of this
 * list is the order of insertion, so Mira (the demo login) always gets the first id of a fresh database.
 */

export interface SeedPerson {
  /** Stable handle that content.ts uses to refer to a person; never stored. */
  readonly handle: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  /** `null` shows the profile's empty state (no empty strings, `users_bio_chk`). */
  readonly bio: string | null;
  /** Gets a generated abstract avatar; `false` shows the initials fallback. */
  readonly avatar: boolean;
}

export const PEOPLE = [
  {
    handle: 'mira',
    firstName: 'Mira',
    lastName: 'Novak',
    email: 'mira.novak@example.com',
    bio: 'Front-end developer in Leipzig. Collects risograph prints and opinions about bike lanes.',
    avatar: true,
  },
  {
    handle: 'tomas',
    firstName: 'Tomás',
    lastName: 'Ferreira',
    email: 'tomas.ferreira@example.com',
    bio: 'Sound engineer by day, bread baker by night. Sourdough starter is called Gil.',
    avatar: true,
  },
  {
    handle: 'aiko',
    firstName: 'Aiko',
    lastName: 'Tanaka',
    email: 'aiko.tanaka@example.com',
    bio: 'Type designer. Currently drawing a grotesque with too many ampersands.',
    avatar: true,
  },
  {
    handle: 'noah',
    firstName: 'Noah',
    lastName: 'Brennan',
    email: 'noah.brennan@example.com',
    bio: 'Climbing, maps, and the occasional pub quiz win.',
    avatar: false,
  },
  {
    handle: 'priya',
    firstName: 'Priya',
    lastName: 'Raman',
    email: 'priya.raman@example.com',
    bio: 'Data journalist. Ask me about public transport delays, I have charts.',
    avatar: true,
  },
  {
    handle: 'jonas',
    firstName: 'Jonas',
    lastName: 'Weber',
    email: 'jonas.weber@example.com',
    bio: 'Carpenter learning TypeScript. Both involve measuring twice.',
    avatar: true,
  },
  {
    handle: 'amara',
    firstName: 'Amara',
    lastName: 'Okafor',
    email: 'amara.okafor@example.com',
    bio: 'Architect, plant hoarder, Sunday market regular.',
    avatar: true,
  },
  {
    handle: 'mateo',
    firstName: 'Mateo',
    lastName: 'Rossi',
    email: 'mateo.rossi@example.com',
    bio: null,
    avatar: false,
  },
  {
    handle: 'sofia',
    firstName: 'Sofia',
    lastName: 'Lindqvist',
    email: 'sofia.lindqvist@example.com',
    bio: 'Illustrator. Draws the neighbourhood one staircase at a time.',
    avatar: true,
  },
  {
    handle: 'yusuf',
    firstName: 'Yusuf',
    lastName: 'Demir',
    email: 'yusuf.demir@example.com',
    bio: 'Backend developer and amateur beekeeper. 40,000 colleagues.',
    avatar: true,
  },
  {
    handle: 'clara',
    firstName: 'Clara',
    lastName: 'Moreau',
    email: 'clara.moreau@example.com',
    bio: 'Translator (FR/DE/EN). Reading three books at once, finishing none.',
    avatar: false,
  },
  {
    handle: 'ewa',
    firstName: 'Ewa',
    lastName: 'Kowalska',
    email: 'ewa.kowalska@example.com',
    bio: 'Ceramicist. Mostly glaze tests and slightly wonky cups.',
    avatar: true,
  },
  {
    handle: 'daniel',
    firstName: 'Daniel',
    lastName: 'Mensah',
    email: 'daniel.mensah@example.com',
    bio: 'Teaches maths, plays bass, runs the Thursday board game night.',
    avatar: true,
  },
  {
    handle: 'hannah',
    firstName: 'Hannah',
    lastName: 'Schulz',
    email: 'hannah.schulz@example.com',
    bio: null,
    avatar: false,
  },
] as const satisfies readonly SeedPerson[];

/** One of the 14 people, with its literal handle. */
export type DemoPerson = (typeof PEOPLE)[number];
export type PersonHandle = DemoPerson['handle'];

/** The demo login that `pnpm setup:env` and `pnpm demo` print. Its presence means "already seeded". */
export const DEMO_EMAIL = PEOPLE[0].email;
