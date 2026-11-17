import { eq, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { users } from '../../db/schema/index.js';
import { publicUserColumns, type PublicUserRow } from '../../db/selections.js';

/** The public profile of an account plus its password hash: everything a login needs, from one row (B-14). */
export type CredentialsRow = PublicUserRow & { readonly passwordHash: string };

/** What registration stores. `email` is already trimmed and lower-cased by the shared `Email` schema (F-08). */
export interface NewAccount {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly passwordHash: string;
}

/** The auth feature's only access to `users`. SQL lives here and nowhere else in the feature. */
export interface AuthRepository {
  /**
   * The account with this email (case-insensitive), or `undefined` when there is none (B-12): one query on
   * `users_email_lower_idx` that returns the public columns and the hash together (B-14, DATA-MODEL "Login").
   */
  findCredentialsByEmail(email: string): Promise<CredentialsRow | undefined>;
  /**
   * Inserts the account and returns its public columns. A taken email (in any case) rejects with Postgres'
   * unique violation `23505` on `users_email_lower_idx`; the service maps it, so there is no racy pre-check (B-11).
   */
  insertAccount(account: NewAccount): Promise<PublicUserRow>;
  /** Stores an upgraded hash after a successful login with outdated argon2 parameters (ADR-0006). */
  updatePasswordHash(userId: number, passwordHash: string): Promise<void>;
}

export function createAuthRepository(db: Database): AuthRepository {
  return {
    async findCredentialsByEmail(email) {
      const [row] = await db
        .select({ ...publicUserColumns, passwordHash: users.passwordHash })
        .from(users)
        // `lower(email)` matches the expression index exactly; the parameter is normalised too, so a caller that
        // skipped the shared schema still finds the account.
        .where(sql`lower(${users.email}) = lower(${email})`)
        .limit(1);
      return row;
    },

    async insertAccount(account) {
      const [row] = await db.insert(users).values(account).returning(publicUserColumns);
      if (!row) throw new Error('insertAccount: the insert returned no row');
      return row;
    },

    async updatePasswordHash(userId, passwordHash) {
      await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
    },
  };
}
