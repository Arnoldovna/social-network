import type { UserSummaryRow } from '../../../db/selections.js';
import type { Cursor } from '../../../shared/pagination/cursor.js';
import type { NewPost, PostOwnership, WallPostRow, WallRepository } from '../wall.repository.js';

/**
 * In-memory `WallRepository` for the service unit tests. It keeps the same semantics as the Drizzle implementation:
 * newest first by `(createdAt, id)` with the keyset strictly after the cursor and `limit + 1` rows, a guarded delete
 * that only removes the author's or the wall owner's post, and ids that come from a sequence of their own (never the
 * author's user id, B-41).
 */

interface StoredPost {
  id: number;
  wallOwnerId: number;
  authorId: number;
  body: string;
  createdAt: Date;
}

export interface FakeWallRepository extends WallRepository {
  /** Users by id; `userExists` and the author join read them. */
  readonly users: Map<number, UserSummaryRow>;
  /** Every stored post in insertion order. */
  readonly posts: StoredPost[];
  /** Every repository call by method name, in call order (to assert what the service did **not** do). */
  readonly calls: (keyof WallRepository)[];
  addUser(user: UserSummaryRow): UserSummaryRow;
  /** Stores a post as if inserted earlier; `createdAt` defaults to the fake's clock. */
  addPost(post: Omit<StoredPost, 'id' | 'createdAt'> & { createdAt?: Date }): StoredPost;
}

export interface FakeWallRepositoryOptions {
  /** The first post id; defaults far away from the fixtures' user ids, so a post id can never equal a user id. */
  firstPostId?: number;
  now?: () => Date;
}

function isAfter(post: StoredPost, cursor: Cursor): boolean {
  const time = post.createdAt.getTime();
  const cursorTime = cursor.createdAt.getTime();
  return time < cursorTime || (time === cursorTime && post.id < cursor.id);
}

function newestFirst(a: StoredPost, b: StoredPost): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id;
}

export function createFakeWallRepository({
  firstPostId = 1000,
  now = () => new Date(),
}: FakeWallRepositoryOptions = {}): FakeWallRepository {
  const users = new Map<number, UserSummaryRow>();
  const posts: StoredPost[] = [];
  const calls: (keyof WallRepository)[] = [];
  let nextId = firstPostId;

  function joinAuthor(post: StoredPost): WallPostRow {
    const author = users.get(post.authorId);
    // The table's foreign key makes this impossible in Postgres; in the fake it is a broken test setup.
    if (!author) throw new Error(`fake wall repository: author ${String(post.authorId)} does not exist`);
    return {
      id: post.id,
      wallOwnerId: post.wallOwnerId,
      body: post.body,
      createdAt: new Date(post.createdAt),
      author: { ...author },
    };
  }

  function store(post: NewPost & { createdAt?: Date }): StoredPost {
    if (!users.has(post.wallOwnerId)) {
      throw new Error(`fake wall repository: wall owner ${String(post.wallOwnerId)} does not exist`);
    }
    const stored: StoredPost = { ...post, id: nextId++, createdAt: post.createdAt ?? now() };
    posts.push(stored);
    return stored;
  }

  return {
    users,
    posts,
    calls,
    addUser(user) {
      users.set(user.id, user);
      return user;
    },
    addPost(post) {
      return store(post);
    },
    userExists(userId) {
      calls.push('userExists');
      return Promise.resolve(users.has(userId));
    },
    listPosts({ wallOwnerId, limit, after }) {
      calls.push('listPosts');
      const page = posts
        .filter((post) => post.wallOwnerId === wallOwnerId && (!after || isAfter(post, after)))
        .sort(newestFirst)
        .slice(0, limit + 1)
        .map(joinAuthor);
      return Promise.resolve(page);
    },
    insertPost(post) {
      calls.push('insertPost');
      return Promise.resolve(joinAuthor(store(post)));
    },
    findPostOwnership(postId) {
      calls.push('findPostOwnership');
      const post = posts.find(({ id }) => id === postId);
      const ownership: PostOwnership | undefined = post
        ? { id: post.id, wallOwnerId: post.wallOwnerId, authorId: post.authorId }
        : undefined;
      return Promise.resolve(ownership);
    },
    deletePost({ postId, actorId }) {
      calls.push('deletePost');
      const index = posts.findIndex(
        ({ id, authorId, wallOwnerId }) => id === postId && (authorId === actorId || wallOwnerId === actorId),
      );
      const [deleted] = index === -1 ? [] : posts.splice(index, 1);
      return Promise.resolve(deleted ? { id: deleted.id, wallOwnerId: deleted.wallOwnerId } : undefined);
    },
  };
}
