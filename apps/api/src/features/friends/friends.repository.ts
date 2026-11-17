import { and, eq, or, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { friendships, users } from '../../db/schema/index.js';
import { userNameOrder, userSummaryColumns, type UserSummaryRow } from '../../db/selections.js';
import { friendshipPairCondition } from './friendship-reader.js';
import type { FriendshipRowState } from './friendship-state.js';

type FriendshipTableRow = typeof friendships.$inferSelect;

/**
 * One friendship of a user joined with the *other* party's public columns (`userSummaryColumns`, B-19). The state is
 * not a column: the service derives it with `deriveFriendshipState` from `status`, `requesterId` and `addresseeId`
 * (B-53).
 */
export interface FriendshipListRow extends FriendshipRowState, Pick<FriendshipTableRow, 'createdAt' | 'acceptedAt'> {
  user: UserSummaryRow;
}

/**
 * SQL of the friends feature (DATA-MODEL.md, "Key queries"). Repositories return rows or `undefined`; the service
 * decides what a missing row means (404 vs 409, ADR-0004). The read-only port for other features is
 * `friendship-reader.ts`, not this interface.
 */
export interface FriendsRepository {
  /**
   * Every friendship row of `userId` (accepted, pending incoming and pending outgoing) with the other user, ordered by
   * that user's name (case-insensitive first name, last name, then id). One query, so the three lists of the friends
   * page come from one consistent snapshot.
   */
  listFor(userId: number): Promise<FriendshipListRow[]>;
  userExists(userId: number): Promise<boolean>;
  /**
   * Inserts a pending request `requesterId → addresseeId` unless the pair already has a row in either direction
   * (`on conflict do nothing` on `friendships_pair_idx`, B-25): `undefined` then, never a second row and never a 23505.
   */
  insertRequest(requesterId: number, addresseeId: number): Promise<{ id: number } | undefined>;
  /**
   * Accepts the pending request `requesterId → addresseeId` (the addressee is the one accepting, F-48). `undefined`
   * when no such pending row exists: the zero-row update is a 404, never a silent success (B-26).
   */
  acceptRequest(requesterId: number, addresseeId: number): Promise<{ id: number } | undefined>;
  /**
   * Deletes the pair's row whichever side asked and whatever its status (cancel, decline, unfriend) and returns what
   * it was, so the service knows whether it ended a friendship. `undefined` when the pair has no row.
   */
  deletePair(a: number, b: number): Promise<FriendshipRowState | undefined>;
}

const rowStateColumns = {
  status: friendships.status,
  requesterId: friendships.requesterId,
  addresseeId: friendships.addresseeId,
} as const;

export function createFriendsRepository(db: Database): FriendsRepository {
  return {
    async listFor(userId) {
      // The other party of each row; `userId` is a bound parameter.
      const otherUserId = sql`case when ${friendships.requesterId} = ${userId}
        then ${friendships.addresseeId} else ${friendships.requesterId} end`;
      return (
        db
          .select({
            ...rowStateColumns,
            createdAt: friendships.createdAt,
            acceptedAt: friendships.acceptedAt,
            user: userSummaryColumns,
          })
          .from(friendships)
          .innerJoin(users, eq(users.id, otherUserId))
          // Both sides are leading columns of `friendships_requester_status_idx` / `friendships_addressee_status_idx`.
          .where(or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId)))
          // Same name order as the user search (DATA-MODEL.md), with the id as a stable tie-breaker.
          .orderBy(...userNameOrder())
      );
    },

    async userExists(userId) {
      const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
      return row !== undefined;
    },

    async insertRequest(requesterId, addresseeId) {
      const [row] = await db
        .insert(friendships)
        .values({ requesterId, addresseeId, status: 'pending' })
        // No conflict target: any unique violation, i.e. the unordered pair index, means "a row already exists".
        .onConflictDoNothing()
        .returning({ id: friendships.id });
      return row;
    },

    async acceptRequest(requesterId, addresseeId) {
      const [row] = await db
        .update(friendships)
        // The database clock, like `created_at`; `friendships_accepted_at_chk` ties it to the status.
        .set({ status: 'accepted', acceptedAt: sql`now()` })
        .where(
          and(
            eq(friendships.requesterId, requesterId),
            eq(friendships.addresseeId, addresseeId),
            eq(friendships.status, 'pending'),
          ),
        )
        .returning({ id: friendships.id });
      return row;
    },

    async deletePair(a, b) {
      const [row] = await db.delete(friendships).where(friendshipPairCondition(a, b)).returning(rowStateColumns);
      return row;
    },
  };
}
