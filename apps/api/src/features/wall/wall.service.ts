import { canDeleteWallPost, type CreatePostBody, type PageQuery, type WallPage, type WallPost } from '@app/shared';

import { toUserSummary } from '../../db/selections.js';
import type { Actor } from '../../shared/auth/guards.js';
import { AppError, UserNotFoundError } from '../../shared/errors/app-error.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import { pagePosition, toPage } from '../../shared/pagination/cursor.js';
import type { FriendshipReader } from '../../shared/ports/friendship-reader.js';
import { rooms } from '../../shared/realtime/rooms.js';
import type { RealtimePublisher } from '../../shared/realtime/types.js';
import type { WallPostRow, WallRepository } from './wall.repository.js';

// Business errors of the wall (API.md §4). Their `detail` is client-safe; the socket ack of `wall:join` reuses it
// (`toSocketFailure` in shared/realtime/ack.ts maps 403 -> `forbidden`, 404 -> `not-found`).

/** F-65, B-23: reading a wall that is neither the viewer's own nor a friend's. */
export class WallForbiddenError extends AppError {
  constructor() {
    super({
      status: 403,
      code: 'wall-forbidden',
      title: 'Forbidden',
      detail: 'Only this user and their friends can see this wall.',
    });
  }
}

/** F-66, B-22: posting on a wall that is neither the author's own nor a friend's. */
export class WallWriteForbiddenError extends AppError {
  constructor() {
    super({
      status: 403,
      code: 'wall-write-forbidden',
      title: 'Forbidden',
      detail: 'Only this user and their friends can post on this wall.',
    });
  }
}

/** F-71, B-21: deleting a post that is neither the actor's own nor on the actor's wall. */
export class PostDeleteForbiddenError extends AppError {
  constructor() {
    super({
      status: 403,
      code: 'post-delete-forbidden',
      title: 'Forbidden',
      detail: 'Only the author of this post or the owner of this wall can delete it.',
    });
  }
}

export class PostNotFoundError extends AppError {
  constructor() {
    super({ status: 404, code: 'post-not-found', title: 'Not found', detail: 'This post does not exist.' });
  }
}

export interface WallServiceDeps {
  repository: WallRepository;
  /** Owner-or-friend rule for reading and posting (ADR-0011). */
  friendships: FriendshipReader;
  /** `wall:post-created` / `wall:post-deleted` to `rooms.wall(ownerId)` only (F-72, B-40). */
  publisher: RealtimePublisher;
  avatarUrl: AvatarUrl;
}

export type WallService = ReturnType<typeof createWallService>;

/**
 * Rules of the wall (FEATURES §9, ADR-0011): a wall is read and written by its owner and the owner's accepted friends
 * only; a post is deleted by its author or the wall owner only. History is served over HTTP, changes are pushed to the
 * wall's room (ADR-0008).
 */
export function createWallService({ repository, friendships, publisher, avatarUrl }: WallServiceDeps) {
  const toWallPost = (row: WallPostRow): WallPost => ({
    id: row.id,
    wallOwnerId: row.wallOwnerId,
    author: toUserSummary(row.author, avatarUrl),
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  });

  /** The one rule of reading and writing (F-65, F-66). The reader is only asked about two different users. */
  async function isOwnerOrFriend(viewerId: number, wallOwnerId: number): Promise<boolean> {
    return viewerId === wallOwnerId || friendships.areFriends(viewerId, wallOwnerId);
  }

  /** 404 for an unknown wall first, then the permission: a missing user is the same 404 for everyone (F-42). */
  async function assertAccess(viewerId: number, wallOwnerId: number, forbidden: () => AppError): Promise<void> {
    if (!(await repository.userExists(wallOwnerId))) throw new UserNotFoundError();
    if (!(await isOwnerOrFriend(viewerId, wallOwnerId))) throw forbidden();
  }

  return {
    /**
     * Permission of `wall:join` (B-23, B-39): the same read rule as the HTTP history, so a socket can only receive
     * the changes of a wall its user may read.
     */
    async assertCanView(actor: Actor, wallOwnerId: number): Promise<void> {
      await assertAccess(actor.userId, wallOwnerId, () => new WallForbiddenError());
    },

    /** `GET /api/users/:id/posts`: newest first, keyset-paginated (F-70, B-72, B-73). */
    async listPosts(actor: Actor, wallOwnerId: number, { limit, cursor }: PageQuery): Promise<WallPage> {
      // A malformed cursor is a malformed request (400 `invalid-cursor`), whoever sends it.
      const position = pagePosition(cursor);
      await assertAccess(actor.userId, wallOwnerId, () => new WallForbiddenError());
      const rows = await repository.listPosts({ wallOwnerId, limit, ...position });
      const page = toPage(rows, limit);
      return { items: page.items.map(toWallPost), nextCursor: page.nextCursor };
    },

    /** `POST /api/users/:id/posts`: checked before the insert (B-22), then pushed to the wall's room only (B-40). */
    async createPost(actor: Actor, wallOwnerId: number, { body }: CreatePostBody): Promise<WallPost> {
      await assertAccess(actor.userId, wallOwnerId, () => new WallWriteForbiddenError());
      const post = toWallPost(await repository.insertPost({ wallOwnerId, authorId: actor.userId, body }));
      publisher.emitToRoom(rooms.wall(wallOwnerId), 'wall:post-created', post);
      return post;
    },

    /**
     * `DELETE /api/posts/:id` (F-71, B-21), as DATA-MODEL "Delete post" prescribes: the guarded `DELETE … RETURNING`
     * is authoritative and the only statement of a permitted delete. Only when it matched no row does a second
     * `select` tell the two failures apart, through the shared `canDeleteWallPost` policy the web app uses to show
     * the delete button (B-90).
     */
    async deletePost(actor: Actor, postId: number): Promise<void> {
      const deleted = await repository.deletePost({ postId, actorId: actor.userId });
      if (!deleted) {
        const post = await repository.findPostOwnership(postId);
        if (
          post &&
          !canDeleteWallPost(actor.userId, { wallOwnerId: post.wallOwnerId, author: { id: post.authorId } })
        ) {
          throw new PostDeleteForbiddenError();
        }
        // No such post (never existed, or deleted concurrently). A post the policy allows always matches the guarded
        // delete, so it cannot reach this line while it still exists.
        throw new PostNotFoundError();
      }
      publisher.emitToRoom(rooms.wall(deleted.wallOwnerId), 'wall:post-deleted', {
        id: deleted.id,
        wallOwnerId: deleted.wallOwnerId,
      });
    },
  };
}
