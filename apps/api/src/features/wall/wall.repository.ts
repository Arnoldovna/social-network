import { and, desc, eq, or } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { keysetAfter } from '../../db/keyset.js';
import { users, wallPosts } from '../../db/schema/index.js';
import { userSummaryColumns, type UserSummaryRow } from '../../db/selections.js';
import type { Cursor } from '../../shared/pagination/cursor.js';

/**
 * A post joined with its author's public columns (B-19: never `select *` on users). Row types stay inside the feature;
 * the service maps them to the shared `WallPost` DTO.
 */
export interface WallPostRow {
  id: number;
  wallOwnerId: number;
  body: string;
  createdAt: Date;
  author: UserSummaryRow;
}

/** Who may delete a post: its author and the owner of the wall it is on (F-71). */
export interface PostOwnership {
  id: number;
  wallOwnerId: number;
  authorId: number;
}

export interface NewPost {
  wallOwnerId: number;
  authorId: number;
  /** Already trimmed and length-checked by `CreatePostBody`; the table's CHECK enforces it again (B-70). */
  body: string;
}

/** The service depends on this interface, so its unit tests run against an in-memory fake (`__tests__/fakes.ts`). */
export interface WallRepository {
  /** Whether the wall's owner exists (404 `user-not-found` otherwise). */
  userExists(userId: number): Promise<boolean>;
  /**
   * One page of a wall, newest first (`created_at DESC, id DESC`, B-72), strictly after `after`; `limit + 1` rows so
   * `toPage` can tell whether another page exists (ADR-0014).
   */
  listPosts(params: { wallOwnerId: number; limit: number; after?: Cursor }): Promise<WallPostRow[]>;
  /** Inserts the post and returns it joined with its author in **one** statement (B-41, B-75). */
  insertPost(post: NewPost): Promise<WallPostRow>;
  /** Author and wall of a post; read only after a guarded delete missed, to answer 404 or 403. */
  findPostOwnership(postId: number): Promise<PostOwnership | undefined>;
  /**
   * Deletes the post only if `actorId` is its author or the wall owner (the SQL guard of B-21) and returns what was
   * deleted; `undefined` when no row matched (no such post, or not the actor's to delete).
   */
  deletePost(params: { postId: number; actorId: number }): Promise<{ id: number; wallOwnerId: number } | undefined>;
}

/** Column selection shared by the page query and the insert CTE, so both return exactly a `WallPostRow`. */
const postColumns = {
  id: wallPosts.id,
  wallOwnerId: wallPosts.wallOwnerId,
  body: wallPosts.body,
  createdAt: wallPosts.createdAt,
} as const;

export function createWallRepository(db: Database): WallRepository {
  return {
    async userExists(userId) {
      const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
      return row !== undefined;
    },

    async listPosts({ wallOwnerId, limit, after }) {
      // DATA-MODEL "Wall page": served from `wall_posts_wall_created_idx` without a sort (ADR-0014).
      return db
        .select({ ...postColumns, author: userSummaryColumns })
        .from(wallPosts)
        .innerJoin(users, eq(users.id, wallPosts.authorId))
        .where(
          and(
            eq(wallPosts.wallOwnerId, wallOwnerId),
            keysetAfter({ createdAt: wallPosts.createdAt, id: wallPosts.id }, after),
          ),
        )
        .orderBy(desc(wallPosts.createdAt), desc(wallPosts.id))
        .limit(limit + 1);
    },

    async insertPost(post) {
      // DATA-MODEL "Create post": `with inserted as (insert … returning …) select … join users`. The DTO's id and
      // timestamp come from the inserted row and the author from the same statement, so the realtime payload can
      // never carry the author's user id as the post id (B-41) and needs no second round trip (B-75).
      const inserted = db.$with('inserted').as(
        db
          .insert(wallPosts)
          .values(post)
          .returning({ ...postColumns, authorId: wallPosts.authorId }),
      );
      const [row] = await db
        .with(inserted)
        .select({
          id: inserted.id,
          wallOwnerId: inserted.wallOwnerId,
          body: inserted.body,
          createdAt: inserted.createdAt,
          author: userSummaryColumns,
        })
        .from(inserted)
        .innerJoin(users, eq(users.id, inserted.authorId));
      if (!row) throw new Error('Inserting a wall post returned no row.');
      return row;
    },

    async findPostOwnership(postId) {
      const [row] = await db
        .select({ id: wallPosts.id, wallOwnerId: wallPosts.wallOwnerId, authorId: wallPosts.authorId })
        .from(wallPosts)
        .where(eq(wallPosts.id, postId))
        .limit(1);
      return row;
    },

    async deletePost({ postId, actorId }) {
      const [row] = await db
        .delete(wallPosts)
        .where(and(eq(wallPosts.id, postId), or(eq(wallPosts.authorId, actorId), eq(wallPosts.wallOwnerId, actorId))))
        .returning({ id: wallPosts.id, wallOwnerId: wallPosts.wallOwnerId });
      return row;
    },
  };
}
