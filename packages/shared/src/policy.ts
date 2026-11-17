import type { UserSummary } from './user.js';
import type { WallPost } from './wall.js';

/**
 * Pure authorization helpers used by the server AND the client, so a rendered button and the enforced rule never
 * disagree (B-90). The server's SQL guard stays authoritative.
 */

/** F-71: the author of a post and the owner of the wall it is on may delete it; nobody else. */
export const canDeleteWallPost = (
  viewerId: number,
  post: Pick<WallPost, 'wallOwnerId'> & { author: Pick<UserSummary, 'id'> },
): boolean => viewerId === post.author.id || viewerId === post.wallOwnerId;
