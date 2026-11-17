import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  AuthResponse,
  ChatPage,
  CreatePostResponse,
  CsrfTokenResponse,
  FriendshipChange,
  FriendshipsResponse,
  FriendshipState,
  Me,
  MeResponse,
  pageOf,
  PresenceResponse,
  PublicUser,
  SearchResponse,
  UserProfileResponse,
  UserSummary,
  WallPage,
} from '../index.js';

// B-19, F-43, F-90: response DTOs are strict at every nesting level, so a private field anywhere in the tree fails.
const summary = { id: 3, firstName: 'Mira', lastName: 'Novak', avatarUrl: null };
const publicUser = { ...summary, bio: 'Hello' };
const createdAt = '2026-11-15T14:05:00.000Z';
const post = { id: 9, wallOwnerId: 2, author: summary, body: 'Hi', createdAt };
const message = { id: 1, author: summary, body: 'Hi', createdAt };
const entry = { user: summary, since: createdAt };
const leak = { email: 'mira.novak@example.com' };

interface Case {
  name: string;
  schema: z.ZodType;
  valid: unknown;
  /** The same value with a private field added at a nested level. */
  nestedLeak?: unknown;
}

const cases: Case[] = [
  { name: 'UserSummary', schema: UserSummary, valid: summary },
  { name: 'PublicUser', schema: PublicUser, valid: publicUser },
  { name: 'Me', schema: Me, valid: publicUser },
  {
    name: 'AuthResponse',
    schema: AuthResponse,
    valid: { user: publicUser, csrfToken: 't' },
    nestedLeak: { user: { ...publicUser, ...leak }, csrfToken: 't' },
  },
  { name: 'CsrfTokenResponse', schema: CsrfTokenResponse, valid: { token: 't' } },
  {
    name: 'MeResponse',
    schema: MeResponse,
    valid: { user: publicUser },
    nestedLeak: { user: { ...publicUser, passwordHash: '$argon2id$...' } },
  },
  {
    name: 'SearchResponse',
    schema: SearchResponse,
    valid: { items: [summary] },
    nestedLeak: { items: [{ ...summary, ...leak }] },
  },
  {
    name: 'UserProfileResponse',
    schema: UserProfileResponse,
    valid: { user: publicUser, relationship: { state: 'friends', canViewWall: true, canPostOnWall: true } },
    nestedLeak: {
      user: publicUser,
      relationship: { state: 'friends', canViewWall: true, canPostOnWall: true, requesterId: 1 },
    },
  },
  {
    name: 'FriendshipsResponse',
    schema: FriendshipsResponse,
    valid: { friends: [entry], incoming: [], outgoing: [] },
    nestedLeak: { friends: [], incoming: [{ user: { ...summary, ...leak }, since: createdAt }], outgoing: [] },
  },
  { name: 'FriendshipChange', schema: FriendshipChange, valid: { userId: 3, state: 'pending_outgoing' } },
  {
    name: 'WallPage',
    schema: WallPage,
    valid: { items: [post], nextCursor: null },
    nestedLeak: { items: [{ ...post, author: { ...summary, ...leak } }], nextCursor: null },
  },
  {
    name: 'CreatePostResponse',
    schema: CreatePostResponse,
    valid: { post },
    nestedLeak: { post: { ...post, author: { ...summary, ...leak } } },
  },
  {
    name: 'ChatPage',
    schema: ChatPage,
    valid: { items: [message], nextCursor: 'c' },
    nestedLeak: { items: [{ ...message, author: { ...summary, ...leak } }], nextCursor: 'c' },
  },
  {
    name: 'PresenceResponse',
    schema: PresenceResponse,
    valid: { items: [summary] },
    nestedLeak: { items: [{ ...summary, ...leak }] },
  },
];

describe.each(cases)('$name', ({ schema, valid }) => {
  it('accepts the documented shape', () => {
    expect(schema.parse(valid)).toEqual(valid);
  });

  it('rejects an extra top-level key', () => {
    expect(schema.safeParse({ ...(valid as object), ...leak }).success).toBe(false);
  });
});

const nestedCases = cases.filter((testCase) => testCase.nestedLeak !== undefined);

it('covers a nested leak for every DTO that nests an object', () => {
  expect(nestedCases.map((testCase) => testCase.name)).toEqual([
    'AuthResponse',
    'MeResponse',
    'SearchResponse',
    'UserProfileResponse',
    'FriendshipsResponse',
    'WallPage',
    'CreatePostResponse',
    'ChatPage',
    'PresenceResponse',
  ]);
});

describe.each(nestedCases)('$name (nested)', ({ schema, valid, nestedLeak }) => {
  it('accepts the same tree without the private field', () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it('rejects an extra key in a nested object', () => {
    expect(schema.safeParse(nestedLeak).success).toBe(false);
  });
});

describe('strictness details', () => {
  it('.extend() keeps the strictness of the base object', () => {
    expect(PublicUser.safeParse({ ...publicUser, createdAt }).success).toBe(false);
    expect(Me.safeParse({ ...publicUser, ...leak }).success).toBe(false);
  });

  it('pageOf() makes the envelope strict while the item schema stays in charge of items', () => {
    const page = pageOf(UserSummary);
    expect(page.safeParse({ items: [], nextCursor: null, total: 3 }).success).toBe(false);
    expect(page.safeParse({ items: [{ ...summary, ...leak }], nextCursor: null }).success).toBe(false);
  });

  it('rejects a missing required field instead of filling it in', () => {
    expect(UserSummary.safeParse({ id: 3, firstName: 'Mira', lastName: 'Novak' }).success).toBe(false);
  });
});

// B-53: the API answers state, never UI labels.
describe('FriendshipState', () => {
  it('lists exactly the four states', () => {
    expect(FriendshipState.options).toEqual(['none', 'pending_outgoing', 'pending_incoming', 'friends']);
  });

  it.each(['Cancel Friend Request', 'Add friend', 'self'])('rejects the label %j', (state) => {
    expect(FriendshipChange.safeParse({ userId: 3, state }).success).toBe(false);
  });

  it('allows self only in the profile relationship', () => {
    const relationship = { state: 'self', canViewWall: true, canPostOnWall: true };
    expect(UserProfileResponse.safeParse({ user: publicUser, relationship }).success).toBe(true);
  });
});
