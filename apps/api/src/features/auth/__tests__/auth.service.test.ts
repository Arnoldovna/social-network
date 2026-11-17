import { randomUUID } from 'node:crypto';

import { Me, ProblemCode } from '@app/shared';
import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakePublisher, createFastHasher, FAST_HASH_PREFIX, type FakePublisher } from '../../../../test/fakes.js';
import type { PasswordHasher } from '../../../shared/auth/password.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { createAvatarUrl } from '../../../shared/media/media-url.js';
import { sessionCookieClearOptions } from '../auth.controller.js';
import {
  createAuthService,
  EMAIL_TAKEN_MESSAGE,
  EmailTakenError,
  INVALID_CREDENTIALS_MESSAGE,
  InvalidCredentialsError,
  type AuthService,
} from '../auth.service.js';
import { createFakeAuthRepository, uniqueViolation, type FakeAuthRepository } from './fakes.js';

const PASSWORD = 'correct horse battery';

let accounts: FakeAuthRepository;
let hasher: PasswordHasher;
let publisher: FakePublisher;
let timingDummyHash: string;
/** Every JSON line the service logged (pino with an in-memory destination, so the real logger API is used). */
let logLines: Record<string, unknown>[];
let service: AuthService;

beforeEach(async () => {
  accounts = createFakeAuthRepository();
  hasher = createFastHasher();
  publisher = createFakePublisher();
  timingDummyHash = await hasher.hash(randomUUID());
  logLines = [];
  const logger = pino(
    { level: 'warn' },
    {
      write: (line: string) => {
        logLines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  service = createAuthService({ accounts, hasher, timingDummyHash, avatarUrl: createAvatarUrl(), publisher, logger });
});

async function seedAccount(fields: { email?: string; avatarKey?: string | null } = {}) {
  return accounts.seed({ email: `${randomUUID()}@example.com`, passwordHash: await hasher.hash(PASSWORD), ...fields });
}

/** Runs `promise`, expects it to reject with an `AppError`, and returns that error for assertions. */
async function appErrorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  if (!(error instanceof AppError)) throw new Error(`expected an AppError, got ${String(error)}`);
  return error;
}

describe('register', () => {
  const input = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', password: PASSWORD };

  it('F-06, B-19: returns the new account as Me, with public fields only', async () => {
    const me = await service.register(input);

    expect(Me.parse(me)).toEqual({ id: me.id, firstName: 'Ada', lastName: 'Lovelace', bio: null, avatarUrl: null });
    expect(JSON.stringify(me)).not.toContain('example.com');
  });

  it('F-17: stores the hasher output, never the plain password', async () => {
    const me = await service.register(input);
    const stored = accounts.accounts.get(me.id);

    expect(stored?.passwordHash.startsWith(FAST_HASH_PREFIX)).toBe(true);
    expect(stored?.passwordHash).not.toContain(PASSWORD);
    expect(await hasher.verify(stored?.passwordHash ?? '', PASSWORD)).toBe(true);
  });

  it('F-10, B-10, B-11: a taken email in any case is EmailTakenError (409 email-taken, field error on email)', async () => {
    await service.register(input);

    const error = await appErrorOf(service.register({ ...input, email: 'ADA@example.com', firstName: 'Other' }));

    expect(error).toBeInstanceOf(EmailTakenError);
    expect(error).toMatchObject({ status: 409, code: 'email-taken', message: EMAIL_TAKEN_MESSAGE });
    expect(error.extensions).toEqual({
      errors: [{ location: 'body', path: 'email', message: 'An account with this email already exists.' }],
    });
    expect(ProblemCode.parse(error.code)).toBe('email-taken');
    expect(accounts.accounts.size).toBe(1);
  });

  it('B-11: the conflict is decided by the insert (no racy pre-check), and its cause is kept for the log', async () => {
    const violation = uniqueViolation('users_email_lower_idx');
    vi.spyOn(accounts, 'insertAccount').mockRejectedValueOnce(violation);

    const error = await appErrorOf(service.register(input));

    expect(error).toBeInstanceOf(EmailTakenError);
    expect(error.cause).toBe(violation);
    expect(accounts.calls).not.toContain('findCredentialsByEmail');
  });

  it('passes any other database failure through unchanged (a 500, not a 409)', async () => {
    const failure = new Error('connection terminated');
    vi.spyOn(accounts, 'insertAccount').mockRejectedValueOnce(failure);

    await expect(service.register(input)).rejects.toBe(failure);
  });
});

describe('login', () => {
  it('F-14: returns the account as Me for the right password', async () => {
    const account = await seedAccount();

    const me = await service.login({ email: account.email, password: PASSWORD });

    expect(Me.parse(me)).toEqual({
      id: account.id,
      firstName: account.firstName,
      lastName: account.lastName,
      bio: null,
      avatarUrl: null,
    });
  });

  it('F-14: the avatar URL is built from the stored key (ADR-0010)', async () => {
    const version = randomUUID();
    const account = await seedAccount();
    accounts.accounts.set(account.id, { ...account, avatarKey: `avatars/${String(account.id)}/${version}.webp` });

    const me = await service.login({ email: account.email, password: PASSWORD });

    expect(me.avatarUrl).toBe(`/api/users/${String(account.id)}/avatar?v=${version}`);
  });

  it('F-15, B-12, B-13: an unknown email verifies against the dummy hash once, then fails with invalid-credentials', async () => {
    const verify = vi.spyOn(hasher, 'verify');

    const error = await appErrorOf(service.login({ email: 'nobody@example.com', password: PASSWORD }));

    expect(error).toBeInstanceOf(InvalidCredentialsError);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(timingDummyHash, PASSWORD);
  });

  it('F-15: a wrong password fails exactly like an unknown email (status, code, title, message)', async () => {
    const account = await seedAccount();
    const verify = vi.spyOn(hasher, 'verify');

    const wrongPassword = await appErrorOf(service.login({ email: account.email, password: 'not the password' }));
    const unknownEmail = await appErrorOf(service.login({ email: 'nobody@example.com', password: 'not the password' }));

    const visible = ({ status, code, title, message, extensions }: AppError) => ({
      status,
      code,
      title,
      message,
      extensions,
    });
    expect(visible(wrongPassword)).toEqual(visible(unknownEmail));
    expect(visible(wrongPassword)).toEqual({
      status: 401,
      code: 'invalid-credentials',
      title: 'Unauthorized',
      message: INVALID_CREDENTIALS_MESSAGE,
      extensions: {},
    });
    expect(INVALID_CREDENTIALS_MESSAGE).toBe('Email or password is incorrect.');
    // One full verification per attempt either way (B-13).
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('B-14: one repository query per login, also for an unknown email', async () => {
    const account = await seedAccount();

    await service.login({ email: account.email, password: PASSWORD });
    await appErrorOf(service.login({ email: 'nobody@example.com', password: PASSWORD }));

    expect(accounts.calls).toEqual(['findCredentialsByEmail', 'findCredentialsByEmail']);
  });

  it('ADR-0006: a successful login with outdated hash parameters stores an upgraded hash', async () => {
    const account = await seedAccount();
    const original = account.passwordHash;
    vi.spyOn(hasher, 'needsRehash').mockReturnValueOnce(true);

    await service.login({ email: account.email, password: PASSWORD });

    const upgraded = accounts.accounts.get(account.id)?.passwordHash ?? '';
    expect(accounts.calls).toEqual(['findCredentialsByEmail', 'updatePasswordHash']);
    expect(upgraded).not.toBe(original);
    expect(await hasher.verify(upgraded, PASSWORD)).toBe(true);
  });

  it('ADR-0006: a failed hash upgrade is logged and the correct password still logs in (never a 500)', async () => {
    const account = await seedAccount();
    const original = account.passwordHash;
    vi.spyOn(hasher, 'needsRehash').mockReturnValueOnce(true);
    vi.spyOn(accounts, 'updatePasswordHash').mockRejectedValueOnce(new Error('lock timeout'));

    const me = await service.login({ email: account.email, password: PASSWORD });

    expect(me.id).toBe(account.id);
    expect(accounts.accounts.get(account.id)?.passwordHash).toBe(original);
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toMatchObject({
      level: 40,
      msg: 'could not upgrade the password hash',
      userId: account.id,
      err: { message: 'lock timeout' },
    });
  });

  it('ADR-0006: a current hash is left alone, and a failed login never rehashes', async () => {
    const account = await seedAccount();
    const needsRehash = vi.spyOn(hasher, 'needsRehash').mockReturnValue(true);

    await appErrorOf(service.login({ email: account.email, password: 'not the password' }));
    expect(accounts.calls).toEqual(['findCredentialsByEmail']);

    needsRehash.mockReturnValue(false);
    await service.login({ email: account.email, password: PASSWORD });
    expect(accounts.calls).not.toContain('updatePasswordHash');
  });

  it('F-09: the password is compared exactly as sent (never trimmed)', async () => {
    const account = await seedAccount();

    await expect(service.login({ email: account.email, password: ` ${PASSWORD} ` })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });
});

describe('endSession', () => {
  it("F-20: disconnects every socket of the destroyed session, and only that session's", () => {
    service.endSession('session-a');

    expect(publisher.disconnectedSessions).toEqual(['session-a']);
    expect(publisher.emits).toEqual([]);
  });
});

describe('sessionCookieClearOptions (logout)', () => {
  const issued = { path: '/', httpOnly: true, sameSite: 'lax', domain: undefined } as const;

  it('F-20: deleting the production cookie repeats its Secure, HttpOnly, SameSite=Lax, Path=/', () => {
    expect(sessionCookieClearOptions({ ...issued, secure: true }, false)).toEqual({
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
    });
  });

  it('F-20: on local http the deletion is not Secure, like the cookie itself', () => {
    expect(sessionCookieClearOptions({ ...issued, secure: false }, true)).toEqual({
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
    });
  });

  it("follows the request for secure: 'auto', and keeps any other attribute the cookie was issued with", () => {
    const custom = { path: '/api', httpOnly: true, sameSite: 'strict', domain: 'example.com', secure: 'auto' } as const;

    expect(sessionCookieClearOptions(custom, true)).toEqual({
      path: '/api',
      httpOnly: true,
      sameSite: 'strict',
      domain: 'example.com',
      secure: true,
    });
    expect(sessionCookieClearOptions(custom, false)).toMatchObject({ secure: false });
  });
});
