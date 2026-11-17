import type { PublicUserRow, UserSummaryRow } from '../../../db/selections.js';
import { LIKE_ESCAPE } from '../search-pattern.js';
import type { SearchUsersParams, UsersRepository } from '../users.repository.js';

/**
 * In-memory `UsersRepository` for the service unit tests. It mirrors the SQL of the real repository: `LIKE` with the
 * backslash escape on lower-cased first, last and full name, the searcher excluded, ordered by lower-cased first name,
 * last name, then id. The real query is covered by `users.routes.int.test.ts`.
 */
export interface FakeUsersRepository extends UsersRepository {
  /** Adds a user with the next id (from 1) and returns its public row. */
  add(fields: Partial<Omit<PublicUserRow, 'id'>> & Pick<PublicUserRow, 'firstName'>): PublicUserRow;
  /** The stored row, for assertions on what the service wrote. */
  get(id: number): PublicUserRow | undefined;
  /** Every `search` call in order, to assert the pattern and the exclusion the service passed. */
  readonly searches: SearchUsersParams[];
}

/**
 * Translates a `LIKE` pattern with `LIKE_ESCAPE` into an anchored regular expression: `%` is any run of characters,
 * `_` exactly one, an escaped character is itself. A trailing lone escape character is an error, as in Postgres.
 */
export function likeToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern.charAt(index);
    if (char === LIKE_ESCAPE) {
      index++;
      if (index >= pattern.length) throw new Error('LIKE pattern must not end with the escape character');
      source += RegExp.escape(pattern.charAt(index));
    } else if (char === '%') {
      source += '.*';
    } else if (char === '_') {
      source += '.';
    } else {
      source += RegExp.escape(char);
    }
  }
  return new RegExp(`^${source}$`, 'su');
}

const copy = (row: PublicUserRow): PublicUserRow => ({ ...row });

export function createFakeUsersRepository(): FakeUsersRepository {
  const rows = new Map<number, PublicUserRow>();
  const searches: SearchUsersParams[] = [];
  let nextId = 1;

  return {
    searches,
    add({ firstName, lastName = 'Tester', bio = null, avatarKey = null }) {
      const row: PublicUserRow = { id: nextId++, firstName, lastName, bio, avatarKey };
      rows.set(row.id, row);
      return copy(row);
    },
    get(id) {
      const row = rows.get(id);
      return row && copy(row);
    },
    findPublicById(id) {
      const row = rows.get(id);
      return Promise.resolve(row && copy(row));
    },
    updateBio(id, bio) {
      const row = rows.get(id);
      if (!row) return Promise.resolve(undefined);
      row.bio = bio;
      return Promise.resolve(copy(row));
    },
    search(params) {
      searches.push({ ...params });
      const matcher = likeToRegExp(params.pattern.toLowerCase());
      const matches = (value: string): boolean => matcher.test(value.toLowerCase());
      const found: UserSummaryRow[] = [...rows.values()]
        .filter((row) => row.id !== params.excludeUserId)
        .filter((row) => matches(row.firstName) || matches(row.lastName) || matches(`${row.firstName} ${row.lastName}`))
        .sort(
          (a, b) =>
            a.firstName.toLowerCase().localeCompare(b.firstName.toLowerCase()) ||
            a.lastName.toLowerCase().localeCompare(b.lastName.toLowerCase()) ||
            a.id - b.id,
        )
        .slice(0, params.limit)
        .map(({ id, firstName, lastName, avatarKey }) => ({ id, firstName, lastName, avatarKey }));
      return Promise.resolve(found);
    },
  };
}
