import type {
  Me,
  MeResponse,
  RelationshipState,
  SearchQuery,
  SearchResponse,
  UpdateMeBody,
  UserProfileResponse,
} from '@app/shared';

import { toPublicUser, toUserSummary } from '../../db/selections.js';
import type { Actor } from '../../shared/auth/guards.js';
import { UnauthorizedError, UserNotFoundError } from '../../shared/errors/app-error.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { FriendshipReader } from '../../shared/ports/friendship-reader.js';
import type { UsersRepository } from './users.repository.js';
import { prefixPattern } from './search-pattern.js';

export interface UsersServiceDeps {
  repository: UsersRepository;
  /** The friends module's reader (F-45): the only source of a profile's relationship state. */
  friendships: FriendshipReader;
  avatarUrl: AvatarUrl;
}

type Relationship = UserProfileResponse['relationship'];

/**
 * F-45, F-65, F-66: the viewer's relationship to a profile and what it allows. The owner and accepted friends may read
 * and post on a wall; a pending request in either direction grants nothing. The wall module enforces the same rule on
 * its own routes; these flags only tell the client what to render.
 */
function relationshipFor(state: RelationshipState): Relationship {
  const allowed = state === 'self' || state === 'friends';
  return { state, canViewWall: allowed, canPostOnWall: allowed };
}

export type UsersService = ReturnType<typeof createUsersService>;

/**
 * Rules of the users feature: the signed-in user's own profile (F-21, F-28, F-29), other profiles with the
 * relationship (F-40–F-45) and user search (F-59–F-64). Logs nothing: bios and search terms are user content (B-56,
 * OVERVIEW §12).
 */
export function createUsersService({ repository, friendships, avatarUrl }: UsersServiceDeps) {
  /**
   * The session names a user id; a user that no longer exists has no profile to show, so the session is treated as
   * not signed in (401), which sends the client to the login page instead of an error page.
   */
  async function ownUser(actor: Actor): Promise<Me> {
    const row = await repository.findPublicById(actor.userId);
    if (!row) throw new UnauthorizedError();
    return toPublicUser(row, avatarUrl);
  }

  return {
    /** `GET /api/me` (F-21): public fields only, no email and no timestamps. */
    async getMe(actor: Actor): Promise<MeResponse> {
      return { user: await ownUser(actor) };
    },

    /**
     * `PATCH /api/me` (F-28, F-29, B-56): the body is already trimmed and limited by `UpdateMeBody`, and a blank bio is
     * already `null`, so the bio is stored exactly as validated. Only the bio can change; other body keys never reach
     * this method (Zod strips them). Saving the unchanged bio stores the same value again.
     */
    async updateMe(actor: Actor, { bio }: UpdateMeBody): Promise<MeResponse> {
      const row = await repository.updateBio(actor.userId, bio);
      if (!row) throw new UnauthorizedError();
      return { user: toPublicUser(row, avatarUrl) };
    },

    /**
     * `GET /api/users/:id` (F-40–F-45): the public profile and the viewer's relationship. The own id answers `self`
     * (the client redirects to `/`, F-41) without asking the friendship reader, which only knows pairs of two users.
     */
    async getProfile(actor: Actor, userId: number): Promise<UserProfileResponse> {
      const row = await repository.findPublicById(userId);
      if (!row) throw new UserNotFoundError();
      const state: RelationshipState =
        userId === actor.userId ? 'self' : await friendships.stateBetween(actor.userId, userId);
      return { user: toPublicUser(row, avatarUrl), relationship: relationshipFor(state) };
    },

    /**
     * `GET /api/users/search` (F-60, F-61, B-49, B-74): every user whose first name, last name or full name starts with
     * the term, case-insensitively, `%`/`_`/`\` taken literally, the searcher excluded, ordered by name, at most
     * `limit`. No match is an empty list, never an error.
     */
    async search(actor: Actor, { q, limit }: SearchQuery): Promise<SearchResponse> {
      const rows = await repository.search({ pattern: prefixPattern(q), excludeUserId: actor.userId, limit });
      return { items: rows.map((row) => toUserSummary(row, avatarUrl)) };
    },
  };
}
