import { planSeed } from '@app/shared/demo-seed';
import type { PersonHandle } from '@app/shared/demo-seed';

import { hashPassword, newSalt } from './password';
import type { DemoPersistence } from './persistence';
import { DEMO_PASSWORD, DEMO_STATE_VERSION } from './state';
import type { DemoAvatar, DemoState } from './state';

/**
 * The demo's first state, the same data the real `pnpm db:seed` writes (ADR-0020): the 14 people, the friendship
 * graph, the walls, the chat and the avatar designs of `planSeed`, dated relative to `now`. Ids follow the
 * insertion order, so Mira is user 1 as in a fresh database.
 */
export async function buildSeedState(
  now: Date,
  randomUUID: () => string = () => crypto.randomUUID(),
): Promise<DemoState> {
  const { timeline, avatarDesigns } = planSeed(now);

  const avatarOf = (handle: PersonHandle): DemoAvatar | null => {
    const design = avatarDesigns.get(handle);
    return design === undefined ? null : { kind: 'design', design, version: randomUUID() };
  };
  const idByHandle = new Map(timeline.users.map(({ person }, index) => [person.handle, index + 1]));
  const idOf = (handle: PersonHandle): number => {
    const id = idByHandle.get(handle);
    if (id === undefined) throw new Error(`demo seed: unknown person ${handle}`);
    return id;
  };

  const users = await Promise.all(
    timeline.users.map(async ({ person, createdAt }, index) => {
      const salt = newSalt();
      return {
        id: index + 1,
        firstName: person.firstName,
        lastName: person.lastName,
        email: person.email,
        bio: person.bio,
        salt,
        passwordHash: await hashPassword(DEMO_PASSWORD, salt),
        avatar: avatarOf(person.handle),
        createdAt: createdAt.toISOString(),
      };
    }),
  );
  const posts = timeline.posts.map(({ wallOwner, author, body, createdAt }, index) => ({
    id: index + 1,
    wallOwnerId: idOf(wallOwner),
    authorId: idOf(author),
    body,
    createdAt: createdAt.toISOString(),
  }));
  const messages = timeline.messages.map(({ author, body, createdAt }, index) => ({
    id: index + 1,
    authorId: idOf(author),
    body,
    createdAt: createdAt.toISOString(),
  }));

  return {
    version: DEMO_STATE_VERSION,
    users,
    friendships: timeline.friendships.map(({ requester, addressee, status, createdAt, acceptedAt }) => ({
      requesterId: idOf(requester),
      addresseeId: idOf(addressee),
      status,
      createdAt: createdAt.toISOString(),
      acceptedAt: acceptedAt?.toISOString() ?? null,
    })),
    posts,
    messages,
    lastIds: { users: users.length, posts: posts.length, messages: messages.length },
    sessionUserId: null,
  };
}

/**
 * The state the demo starts with: what this browser stored, or a fresh seed (first visit, after "reset demo data", or
 * a stored state of an older shape), which is stored right away.
 */
export async function loadOrSeed(persistence: DemoPersistence, now: Date): Promise<DemoState> {
  const stored = await persistence.load();
  if (stored !== undefined) return stored;
  const state = await buildSeedState(now);
  await persistence.save(state);
  return state;
}
