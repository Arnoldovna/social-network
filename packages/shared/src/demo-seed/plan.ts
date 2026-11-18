import { type AvatarDesign, pickAvatarDesign } from './avatar-design.js';
import { mulberry32, planTimeline, SEED_RANDOM_SEED, type SeedTimeline } from './content.js';
import { PEOPLE, type PersonHandle } from './people.js';

export interface SeedPlan {
  readonly timeline: SeedTimeline;
  /** One generated design per person who gets an avatar (`avatar: true`), keyed by handle. */
  readonly avatarDesigns: ReadonlyMap<PersonHandle, AvatarDesign>;
}

/**
 * Everything the demo data draws from the seeded PRNG, in its one fixed order: the timeline first, then one avatar
 * design per person with an avatar, in `PEOPLE` order. The API seed and the GitHub Pages demo (ADR-0020) both start
 * here, so they show the same dates and the same avatars for the same `now`.
 */
export function planSeed(now: Date): SeedPlan {
  const random = mulberry32(SEED_RANDOM_SEED);
  const timeline = planTimeline(now, random);
  const avatarDesigns = new Map<PersonHandle, AvatarDesign>();
  for (const person of PEOPLE) {
    if (person.avatar) avatarDesigns.set(person.handle, pickAvatarDesign(random));
  }
  return { timeline, avatarDesigns };
}
