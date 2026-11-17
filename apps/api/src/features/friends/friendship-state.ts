import type { FriendshipState } from '@app/shared';

import type { friendships } from '../../db/schema/index.js';

/**
 * The columns of a `friendships` row that decide the per-viewer state. The state itself is never stored (B-53): the
 * row says who asked whom and whether it was accepted, and each side reads it from its own point of view.
 */
export type FriendshipRowState = Pick<typeof friendships.$inferSelect, 'status' | 'requesterId' | 'addresseeId'>;

/**
 * `FriendshipState` of `me` towards the other party of `row` (DATA-MODEL.md, state derivation table; F-45):
 *
 * | Row between me and them        | State              |
 * | ------------------------------ | ------------------ |
 * | none                           | `none`             |
 * | `pending`, `requester_id = me` | `pending_outgoing` |
 * | `pending`, `addressee_id = me` | `pending_incoming` |
 * | `accepted`                     | `friends`          |
 *
 * A row that `me` is not part of is a caller bug (the legacy `/makeRequest` only worked because two wrong reads
 * compared `undefined == undefined`, B-52), so it throws instead of guessing a state.
 */
export function deriveFriendshipState(row: FriendshipRowState | null | undefined, me: number): FriendshipState {
  if (row === null || row === undefined) return 'none';
  const isRequester = row.requesterId === me;
  const isAddressee = row.addresseeId === me;
  if (isRequester === isAddressee) {
    // Neither party (or a self-row, which `friendships_not_self_chk` rules out): never derive a state for it.
    throw new RangeError(`User ${String(me)} is not exactly one party of this friendship row.`);
  }
  switch (row.status) {
    case 'accepted':
      return 'friends';
    case 'pending':
      return isRequester ? 'pending_outgoing' : 'pending_incoming';
  }
}
