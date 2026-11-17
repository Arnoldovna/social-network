import { sql, type SQL } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { friendships } from '../../db/schema/index.js';
import type { FriendshipReader } from '../../shared/ports/friendship-reader.js';
import { deriveFriendshipState, type FriendshipRowState } from './friendship-state.js';

function assertTwoUsers(a: number, b: number): void {
  for (const id of [a, b]) {
    if (!Number.isSafeInteger(id) || id < 1) throw new RangeError('User ids must be positive integers.');
  }
  // A user has no friendship row with themselves; callers answer `'self'` first (shared/ports/friendship-reader.ts).
  if (a === b) throw new RangeError('A friendship is always between two different users.');
}

/**
 * The `WHERE` clause that finds the one row of the unordered pair `{a, b}` (DATA-MODEL.md, "Friendship between a and
 * b"). Its two expressions are exactly those of `friendships_pair_idx`, so Postgres answers it from that unique index
 * whichever side asked first. Exported for the friends repository (cancel, decline, unfriend), which works on the same
 * pair.
 */
export function friendshipPairCondition(a: number, b: number): SQL {
  assertTwoUsers(a, b);
  // Both ids are bound parameters; only the column references are interpolated as identifiers.
  return sql`least(${friendships.requesterId}, ${friendships.addresseeId}) = ${Math.min(a, b)}
    and greatest(${friendships.requesterId}, ${friendships.addresseeId}) = ${Math.max(a, b)}`;
}

/**
 * The real `FriendshipReader` (ADR-0019 §3), wired by the friends module's `index.ts` and passed to users and wall by
 * the composition root. Every call is one indexed point query; no state is cached, so a request always sees the
 * friendship as it is now (an unfriend takes effect on the next request).
 */
export function createFriendshipReader(db: Database): FriendshipReader {
  async function rowBetween(a: number, b: number): Promise<FriendshipRowState | undefined> {
    const [row] = await db
      .select({
        status: friendships.status,
        requesterId: friendships.requesterId,
        addresseeId: friendships.addresseeId,
      })
      .from(friendships)
      .where(friendshipPairCondition(a, b))
      .limit(1);
    return row;
  }

  return {
    async stateBetween(me, them) {
      return deriveFriendshipState(await rowBetween(me, them), me);
    },
    async areFriends(a, b) {
      return (await rowBetween(a, b))?.status === 'accepted';
    },
  };
}
