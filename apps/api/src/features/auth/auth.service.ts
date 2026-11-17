import type { LoginBody, RegisterBody } from '@app/shared';
import type { Logger } from 'pino';

import { toPublicUser, type PublicUserRow } from '../../db/selections.js';
import type { PasswordHasher } from '../../shared/auth/password.js';
import { AppError } from '../../shared/errors/app-error.js';
import { isUniqueViolation } from '../../shared/errors/db-errors.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { RealtimePublisher } from '../../shared/realtime/types.js';
import type { AuthRepository } from './auth.repository.js';
import type { Me } from './auth.schema.js';

/** The one message for an unknown email and a wrong password alike (F-15, B-13). */
export const INVALID_CREDENTIALS_MESSAGE = 'Email or password is incorrect.';
/** Shown next to the email field of the registration form (F-10, B-11). */
export const EMAIL_TAKEN_MESSAGE = 'An account with this email already exists.';

/** 401 `invalid-credentials`: login failed. Never says whether the email exists (F-15). */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super({ status: 401, code: 'invalid-credentials', title: 'Unauthorized', detail: INVALID_CREDENTIALS_MESSAGE });
  }
}

/** 409 `email-taken` with the field error the form shows next to the email input (API.md, F-10, B-11). */
export class EmailTakenError extends AppError {
  constructor(cause?: unknown) {
    super({
      status: 409,
      code: 'email-taken',
      title: 'Conflict',
      detail: EMAIL_TAKEN_MESSAGE,
      cause,
      extensions: { errors: [{ location: 'body', path: 'email', message: EMAIL_TAKEN_MESSAGE }] },
    });
  }
}

export interface AuthServiceDeps {
  accounts: AuthRepository;
  hasher: PasswordHasher;
  /**
   * An argon2id hash (pinned parameters) of a random value. Verified when the email is unknown, so both login failures
   * cost one full verification and take comparable time (F-15, B-13).
   */
  timingDummyHash: string;
  avatarUrl: AvatarUrl;
  /** Logout closes every socket of the destroyed session (F-20). */
  publisher: RealtimePublisher;
  /** A failed password-hash upgrade is logged; the login itself still succeeds (ADR-0006). */
  logger: Pick<Logger, 'warn'>;
}

export interface AuthService {
  /** Creates the account and returns it as `Me`; `EmailTakenError` when the email exists in any case (F-06–F-10). */
  register(input: RegisterBody): Promise<Me>;
  /**
   * The account for these credentials, or `InvalidCredentialsError` (F-14, F-15). Upgrades an outdated hash on the
   * way, best effort: a failed upgrade is logged and never fails the login.
   */
  login(input: LoginBody): Promise<Me>;
  /** Disconnects every socket of the session that logout has just destroyed (F-20). */
  endSession(sessionId: string): void;
}

/**
 * Business rules of registration, login and logout (ADR-0006). Sessions and cookies are HTTP concerns and stay in the
 * controller; this service decides who the user is.
 */
export function createAuthService({
  accounts,
  hasher,
  timingDummyHash,
  avatarUrl,
  publisher,
  logger,
}: AuthServiceDeps): AuthService {
  const toMe = (row: PublicUserRow): Me => toPublicUser(row, avatarUrl);

  /**
   * Best effort (ADR-0006): the password was correct, so a failed upgrade must not turn the login into a 500, which
   * the failed-login limiters would also count against the account's owner. The old hash keeps working and the next
   * login tries again. The error serializer drops query parameters, so the new hash never reaches the log.
   */
  async function upgradeHash(userId: number, password: string): Promise<void> {
    try {
      await accounts.updatePasswordHash(userId, await hasher.hash(password));
    } catch (error) {
      logger.warn({ err: error, userId }, 'could not upgrade the password hash');
    }
  }

  return {
    async register({ firstName, lastName, email, password }) {
      const passwordHash = await hasher.hash(password);
      try {
        return toMe(await accounts.insertAccount({ firstName, lastName, email, passwordHash }));
      } catch (error) {
        // The unique index on lower(email) decides, so two concurrent registrations cannot both succeed (B-10, B-11).
        if (isUniqueViolation(error)) throw new EmailTakenError(error);
        throw error;
      }
    },

    async login({ email, password }) {
      const account = await accounts.findCredentialsByEmail(email);
      // Always exactly one verification, against the dummy hash when there is no account (B-12, B-13).
      const valid = await hasher.verify(account?.passwordHash ?? timingDummyHash, password);
      if (!account || !valid) throw new InvalidCredentialsError();

      if (hasher.needsRehash(account.passwordHash)) await upgradeHash(account.id, password);
      return toMe(account);
    },

    endSession(sessionId) {
      publisher.disconnectSession(sessionId);
    },
  };
}
