import type { FriendEntry, FriendshipChange, FriendshipsResponse } from '@app/shared';

import { toUserSummary } from '../../db/selections.js';
import type { Actor } from '../../shared/auth/guards.js';
import { AppError, ConflictError, UserNotFoundError } from '../../shared/errors/app-error.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import { rooms } from '../../shared/realtime/rooms.js';
import type { RealtimePublisher } from '../../shared/realtime/types.js';
import { deriveFriendshipState, type FriendshipRowState } from './friendship-state.js';
import type { FriendshipListRow, FriendsRepository } from './friends.repository.js';

// ---------------------------------------------------------------------------------------------------------------
// Business errors (API.md §2 "Friendships", §4). The codes come from the shared `ProblemCode` enum.
// ---------------------------------------------------------------------------------------------------------------

/** 422: a request to oneself is well-formed but breaks a rule (F-46, B-24). */
export class CannotBefriendSelfError extends AppError {
  constructor() {
    const detail = 'You cannot send a friend request to yourself.';
    super({
      status: 422,
      code: 'cannot-befriend-self',
      title: 'Unprocessable content',
      detail,
      // Same field-error shape as validation problems, so the client can attach the message to the request.
      extensions: { errors: [{ location: 'body', path: 'userId', message: detail }] },
    });
  }
}

/** 404: no pending request *from* that user *to* the actor, so there is nothing the actor may accept (F-48, B-26). */
export class FriendRequestNotFoundError extends AppError {
  constructor() {
    super({
      status: 404,
      code: 'friend-request-not-found',
      title: 'Not found',
      detail: 'There is no pending friend request from this user.',
    });
  }
}

/** 404: nothing to cancel, decline or end between the actor and that user (F-47, F-49, F-50). */
export class FriendshipNotFoundError extends AppError {
  constructor() {
    super({
      status: 404,
      code: 'friendship-not-found',
      title: 'Not found',
      detail: 'There is no friendship or friend request with this user.',
    });
  }
}

/** 409: the pair already has a row in either direction: pending or accepted (F-46, F-51, B-25). */
export class FriendshipExistsError extends ConflictError {
  constructor() {
    super('A friendship or friend request with this user already exists.', 'friendship-exists');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------------------------

export interface FriendsServiceDeps {
  repository: FriendsRepository;
  /** `friendship:changed` to both users after every mutation; room leaves on unfriend (F-52, F-57, ADR-0008). */
  publisher: RealtimePublisher;
  avatarUrl: AvatarUrl;
}

export type FriendsService = ReturnType<typeof createFriendsService>;

/**
 * Friendship rules (FEATURES §6–7, API.md §2). Each mutation is one conditional statement in the repository, so
 * concurrent or repeated requests cannot create a second row or accept something that is not there (F-51, B-25,
 * B-26). States are never stored or sent as labels: they are derived with `deriveFriendshipState` from the row that
 * was written, for each side from its own point of view (B-52, B-53).
 */
export function createFriendsService({ repository, publisher, avatarUrl }: FriendsServiceDeps) {
  /** The relationship as `viewer` sees it after a mutation; `row` is `undefined` once the pair has no row. */
  const changeFor = (row: FriendshipRowState | undefined, viewer: number, other: number): FriendshipChange => ({
    userId: other,
    state: deriveFriendshipState(row, viewer),
  });

  /**
   * Tells every open tab of both users (`rooms.user(id)`) the new state from their own point of view (API.md §3), so
   * the recipient's nav badge and friends page update in real time (F-52, F-57) and the actor's other tabs follow.
   * Returns the actor's view for the HTTP response, so the response and the event cannot disagree.
   */
  const publish = (row: FriendshipRowState | undefined, actorId: number, otherId: number): FriendshipChange => {
    const forActor = changeFor(row, actorId, otherId);
    publisher.emitToRoom(rooms.user(actorId), 'friendship:changed', forActor);
    publisher.emitToRoom(rooms.user(otherId), 'friendship:changed', changeFor(row, otherId, actorId));
    return forActor;
  };

  const toEntry = (row: FriendshipListRow): FriendEntry => ({
    user: toUserSummary(row.user, avatarUrl),
    since: sinceOf(row).toISOString(),
  });

  return {
    /** `GET /api/friendships` (F-54): the three lists, each in the repository's name order. */
    async list(actor: Actor): Promise<FriendshipsResponse> {
      const result: FriendshipsResponse = { friends: [], incoming: [], outgoing: [] };
      for (const row of await repository.listFor(actor.userId)) {
        switch (deriveFriendshipState(row, actor.userId)) {
          case 'friends':
            result.friends.push(toEntry(row));
            break;
          case 'pending_incoming':
            result.incoming.push(toEntry(row));
            break;
          case 'pending_outgoing':
            result.outgoing.push(toEntry(row));
            break;
          case 'none':
            // A row always yields one of the three states above (DATA-MODEL derivation table).
            throw new Error('A friendship row derived the state none.');
        }
      }
      return result;
    },

    /** `POST /api/friendships` (F-46, F-51; B-24, B-25): 422 self, 404 unknown user, 409 any existing row. */
    async sendRequest(actor: Actor, addresseeId: number): Promise<FriendshipChange> {
      const requesterId = actor.userId;
      // Before any query: the self CHECK would reject it too, but as a 500 instead of the contract's 422.
      if (addresseeId === requesterId) throw new CannotBefriendSelfError();
      if (!(await repository.userExists(addresseeId))) throw new UserNotFoundError();
      // Existence is checked first, so "no row inserted" can only mean the pair already has a row (no account deletion
      // in v1; the FK would still reject a user deleted in between).
      if (!(await repository.insertRequest(requesterId, addresseeId))) throw new FriendshipExistsError();
      return publish({ status: 'pending', requesterId, addresseeId }, requesterId, addresseeId);
    },

    /** `POST /api/friendships/:userId/accept` (F-48, B-26): only the addressee of a pending request. */
    async accept(actor: Actor, requesterId: number): Promise<FriendshipChange> {
      const addresseeId = actor.userId;
      if (requesterId === addresseeId) throw new FriendRequestNotFoundError();
      // The requester "accepting" their own outgoing request matches no row, like a missing or already accepted one.
      if (!(await repository.acceptRequest(requesterId, addresseeId))) throw new FriendRequestNotFoundError();
      return publish({ status: 'accepted', requesterId, addresseeId }, addresseeId, requesterId);
    },

    /**
     * `DELETE /api/friendships/:userId`: cancel (requester, F-47), decline (addressee, F-49, B-27) or unfriend (either
     * friend, F-50). Only a row the actor is part of can match, so nobody can end someone else's friendship.
     */
    async remove(actor: Actor, otherId: number): Promise<FriendshipChange> {
      const actorId = actor.userId;
      if (otherId === actorId) throw new FriendshipNotFoundError();
      const deleted = await repository.deletePair(actorId, otherId);
      if (!deleted) throw new FriendshipNotFoundError();
      if (deleted.status === 'accepted') {
        // A former friend stops receiving the other's wall events immediately (API.md §2, OVERVIEW §8). Pending pairs
        // were never in each other's wall room: `wall:join` requires self or friends (B-39).
        publisher.leaveRoom(rooms.user(actorId), rooms.wall(otherId));
        publisher.leaveRoom(rooms.user(otherId), rooms.wall(actorId));
      }
      return publish(undefined, actorId, otherId);
    },
  };
}

/**
 * Friends since the acceptance, requests since they were sent. `friendships_accepted_at_chk` guarantees `acceptedAt`
 * exactly for accepted rows, so a violation is a broken invariant, not a value to paper over.
 */
function sinceOf(row: FriendshipListRow): Date {
  if (row.status === 'pending') return row.createdAt;
  if (row.acceptedAt === null) throw new Error('An accepted friendship has no acceptedAt.');
  return row.acceptedAt;
}
