import type { PublicUserRow } from '../../../db/selections.js';
import type { AuthRepository, CredentialsRow, NewAccount } from '../auth.repository.js';

/** A stored account of the fake: the public columns, the email and the hash. */
export interface FakeAccount extends CredentialsRow {
  readonly email: string;
}

export interface FakeAuthRepository extends AuthRepository {
  /** Every account by id; tests seed and inspect it directly. */
  readonly accounts: Map<number, FakeAccount>;
  /** Every call in order, e.g. `['findCredentialsByEmail']` for one login (B-14). */
  readonly calls: (keyof AuthRepository)[];
  /** Adds an account as if it had registered earlier and returns it. */
  seed(fields: Partial<Omit<FakeAccount, 'id'>> & Pick<FakeAccount, 'email' | 'passwordHash'>): FakeAccount;
}

/**
 * Shaped like the error Drizzle rejects with for a Postgres unique violation: the driver error (`code: '23505'`) is
 * the `cause`, as in production, so the service's `isUniqueViolation` sees the same structure.
 */
export function uniqueViolation(constraint: string): Error {
  const driverError = Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: '23505',
    constraint,
  });
  return new Error('Failed query: insert into "users" ...', { cause: driverError });
}

const publicColumns = ({ id, firstName, lastName, bio, avatarKey }: FakeAccount): PublicUserRow => ({
  id,
  firstName,
  lastName,
  bio,
  avatarKey,
});

/**
 * In-memory `AuthRepository` with the rules of the `users` table the service relies on: emails are unique
 * case-insensitively (`users_email_lower_idx`) and a duplicate rejects like Postgres does instead of being
 * pre-checked; the hash never leaves through `insertAccount`.
 */
export function createFakeAuthRepository(): FakeAuthRepository {
  const accounts = new Map<number, FakeAccount>();
  const calls: (keyof AuthRepository)[] = [];
  let nextId = 1;

  const byEmail = (email: string): FakeAccount | undefined =>
    [...accounts.values()].find((account) => account.email.toLowerCase() === email.toLowerCase());

  const store = (account: NewAccount & Partial<FakeAccount>): FakeAccount => {
    if (byEmail(account.email)) throw uniqueViolation('users_email_lower_idx');
    const stored: FakeAccount = { bio: null, avatarKey: null, ...account, id: nextId++ };
    accounts.set(stored.id, stored);
    return stored;
  };

  return {
    accounts,
    calls,
    seed(fields) {
      return store({ firstName: 'Seeded', lastName: 'Account', ...fields });
    },
    findCredentialsByEmail(email) {
      calls.push('findCredentialsByEmail');
      return Promise.resolve(byEmail(email));
    },
    insertAccount(account) {
      calls.push('insertAccount');
      // A throw inside the executor (the duplicate) becomes the rejection, as with the real insert.
      return new Promise((resolve) => {
        resolve(publicColumns(store(account)));
      });
    },
    updatePasswordHash(userId, passwordHash) {
      calls.push('updatePasswordHash');
      const account = accounts.get(userId);
      if (account) accounts.set(userId, { ...account, passwordHash });
      return Promise.resolve();
    },
  };
}
