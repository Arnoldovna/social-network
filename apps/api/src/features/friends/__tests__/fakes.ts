import type { UserSummaryRow } from '../../../db/selections.js';
import type { FriendshipListRow, FriendsRepository } from '../friends.repository.js';
import type { FriendshipRowState } from '../friendship-state.js';

/**
 * In-memory `FriendsRepository` for the service unit tests (BUILD-ORDER rule 5: feature fakes live in the feature's
 * own `__tests__/fakes.ts`). It keeps the guarantees the SQL relies on: one row per unordered pair whichever side
 * asked (`friendships_pair_idx`), no self rows (`friendships_not_self_chk`), `acceptedAt` exactly for accepted rows,
 * accept only `requester → addressee` while pending, and the friends page in name order. The real statements are
 * proven against Postgres in `friends.routes.int.test.ts`.
 */

export interface FakeFriendshipRow extends FriendshipRowState {
  id: number;
  createdAt: Date;
  acceptedAt: Date | null;
}

export interface FakeFriendsRepository extends FriendsRepository {
  /** Users by id (the `users` table); `addUser` fills it. */
  readonly users: Map<number, UserSummaryRow>;
  /** The friendship rows by unordered pair key; read it to assert what a mutation wrote. */
  readonly rows: Map<string, FakeFriendshipRow>;
  /** Every repository method call in order, e.g. to prove that a rule is checked before any query. */
  readonly calls: string[];
  addUser(fields: Partial<UserSummaryRow> & { id: number }): UserSummaryRow;
  /** Seeds a row like `test/db.ts#insertFriendship`: `requesterId` asked `addresseeId`. */
  seed(
    requesterId: number,
    addresseeId: number,
    status: FriendshipRowState['status'],
    times?: { createdAt?: Date; acceptedAt?: Date },
  ): FakeFriendshipRow;
  /** The pair's row in either direction. */
  rowOf(a: number, b: number): FakeFriendshipRow | undefined;
}

export const pairKey = (a: number, b: number): string => `${String(Math.min(a, b))}:${String(Math.max(a, b))}`;

/** `lower(first_name), lower(last_name), id`, as the repository's `order by`. */
function byName(a: UserSummaryRow, b: UserSummaryRow): number {
  const first = a.firstName.toLowerCase().localeCompare(b.firstName.toLowerCase());
  if (first !== 0) return first;
  const last = a.lastName.toLowerCase().localeCompare(b.lastName.toLowerCase());
  return last !== 0 ? last : a.id - b.id;
}

export function createFakeFriendsRepository({
  now = () => new Date(),
}: { now?: () => Date } = {}): FakeFriendsRepository {
  const users = new Map<number, UserSummaryRow>();
  const rows = new Map<string, FakeFriendshipRow>();
  const calls: string[] = [];
  let nextId = 1;

  const userOrThrow = (id: number): UserSummaryRow => {
    const user = users.get(id);
    // The FK of the real table.
    if (!user) throw new Error(`fake friends repository: user ${String(id)} does not exist (foreign key)`);
    return user;
  };

  const insert = (
    requesterId: number,
    addresseeId: number,
    status: FriendshipRowState['status'],
    { createdAt = now(), acceptedAt }: { createdAt?: Date; acceptedAt?: Date } = {},
  ): FakeFriendshipRow | undefined => {
    if (requesterId === addresseeId) throw new Error('fake friends repository: self row (friendships_not_self_chk)');
    userOrThrow(requesterId);
    userOrThrow(addresseeId);
    const key = pairKey(requesterId, addresseeId);
    if (rows.has(key)) return undefined;
    const row: FakeFriendshipRow = {
      id: nextId++,
      requesterId,
      addresseeId,
      status,
      createdAt,
      acceptedAt: status === 'accepted' ? (acceptedAt ?? createdAt) : null,
    };
    rows.set(key, row);
    return row;
  };

  const repository: FakeFriendsRepository = {
    users,
    rows,
    calls,

    addUser(fields) {
      const user: UserSummaryRow = {
        firstName: 'Test',
        lastName: `User-${String(fields.id)}`,
        avatarKey: null,
        ...fields,
      };
      users.set(user.id, user);
      return user;
    },

    seed(requesterId, addresseeId, status, times) {
      const row = insert(requesterId, addresseeId, status, times);
      if (!row) throw new Error('fake friends repository: the pair already has a row (friendships_pair_idx)');
      return row;
    },

    rowOf(a, b) {
      return rows.get(pairKey(a, b));
    },

    listFor(userId) {
      calls.push('listFor');
      const result: FriendshipListRow[] = [...rows.values()]
        .filter((row) => row.requesterId === userId || row.addresseeId === userId)
        .map((row) => ({
          status: row.status,
          requesterId: row.requesterId,
          addresseeId: row.addresseeId,
          createdAt: row.createdAt,
          acceptedAt: row.acceptedAt,
          user: { ...userOrThrow(row.requesterId === userId ? row.addresseeId : row.requesterId) },
        }))
        .sort((a, b) => byName(a.user, b.user));
      return Promise.resolve(result);
    },

    userExists(userId) {
      calls.push('userExists');
      return Promise.resolve(users.has(userId));
    },

    insertRequest(requesterId, addresseeId) {
      calls.push('insertRequest');
      const row = insert(requesterId, addresseeId, 'pending');
      return Promise.resolve(row ? { id: row.id } : undefined);
    },

    acceptRequest(requesterId, addresseeId) {
      calls.push('acceptRequest');
      const row = rows.get(pairKey(requesterId, addresseeId));
      if (row?.requesterId !== requesterId || row.addresseeId !== addresseeId || row.status !== 'pending') {
        return Promise.resolve(undefined);
      }
      row.status = 'accepted';
      row.acceptedAt = now();
      return Promise.resolve({ id: row.id });
    },

    deletePair(a, b) {
      calls.push('deletePair');
      const key = pairKey(a, b);
      const row = rows.get(key);
      if (!row) return Promise.resolve(undefined);
      rows.delete(key);
      return Promise.resolve({ status: row.status, requesterId: row.requesterId, addresseeId: row.addresseeId });
    },
  };
  return repository;
}
