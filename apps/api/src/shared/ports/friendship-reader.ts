import type { FriendshipState } from '@app/shared';

/**
 * Read-only view of the friendship graph that features other than `friends` depend on (users, wall). Implemented by
 * `features/friends/friendship-reader.ts` (`createFriendshipReader(db)`, one query on `friendships_pair_idx`) and
 * passed in through module dependencies, so no feature imports another feature's repository (OVERVIEW §5,
 * ADR-0019 §3). Unit tests use the fake from `test/fakes.ts`.
 *
 * Both methods are about two *different* users: callers answer the `'self'` case (`RelationshipState`) themselves
 * before asking, because a user has no friendship row with themselves.
 */
export interface FriendshipReader {
  /** The relationship as seen from `me`: an outgoing request is `pending_outgoing`, an incoming one `pending_incoming`. */
  stateBetween(me: number, them: number): Promise<FriendshipState>;
  /** `true` only for an accepted friendship; symmetric in `a` and `b`. */
  areFriends(a: number, b: number): Promise<boolean>;
}
