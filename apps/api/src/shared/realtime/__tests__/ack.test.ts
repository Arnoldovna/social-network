import { SocketError } from '@app/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  AppError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from '../../errors/app-error.js';
import { SOCKET_ERROR_MESSAGES, ackCallback, fail, ok, toSocketFailure } from '../ack.js';

describe('ok()', () => {
  it('is { ok: true } without data', () => {
    expect(ok()).toStrictEqual({ ok: true });
  });

  it('merges data next to ok', () => {
    expect(ok({ message: { id: 1 } })).toStrictEqual({ ok: true, message: { id: 1 } });
  });

  it('never lets data override ok', () => {
    expect(ok({ ok: false })).toStrictEqual({ ok: true });
  });
});

describe('fail()', () => {
  it('uses the default message of the code', () => {
    expect(fail('forbidden')).toStrictEqual({
      ok: false,
      error: { code: 'forbidden', message: SOCKET_ERROR_MESSAGES.forbidden },
    });
  });

  it('carries retryAfterMs as a whole number of milliseconds (SocketError requires an integer)', () => {
    const { error } = fail('rate-limited', undefined, 1234.2);
    expect(error.retryAfterMs).toBe(1235);
    expect(SocketError.safeParse(error).success).toBe(true);
  });

  it('produces an error that parses with the shared SocketError schema for every code', () => {
    for (const code of Object.keys(SOCKET_ERROR_MESSAGES) as (keyof typeof SOCKET_ERROR_MESSAGES)[]) {
      expect(SocketError.safeParse(fail(code).error).success).toBe(true);
    }
  });
});

describe('toSocketFailure()', () => {
  it.each([
    [new UnauthorizedError(), 'unauthorized'],
    [new ForbiddenError(), 'forbidden'],
    [new NotFoundError('User'), 'not-found'],
    [new TooManyRequestsError(), 'rate-limited'],
    [new ValidationError([], { status: 422 }), 'validation-failed'],
    [new ValidationError([], { status: 400 }), 'validation-failed'],
  ] as const)('maps %s to %s with its client-safe detail', (error, code) => {
    const { failure, expected } = toSocketFailure(error);
    expect(expected).toBe(true);
    expect(failure.error).toStrictEqual({ code, message: error.message });
  });

  it('turns an unknown error into internal without leaking its message (F-106)', () => {
    const { failure, expected } = toSocketFailure(new Error('connection to 10.0.0.5 refused, password=hunter2'));
    expect(expected).toBe(false);
    expect(failure.error).toStrictEqual({ code: 'internal', message: SOCKET_ERROR_MESSAGES.internal });
  });

  it('treats an AppError without a socket meaning (e.g. 409, 500) as internal', () => {
    const conflict = new AppError({ status: 409, code: 'email-taken', title: 'Conflict', detail: 'Taken.' });
    expect(toSocketFailure(conflict)).toStrictEqual({ failure: fail('internal'), expected: false });
  });

  it('handles thrown non-errors', () => {
    expect(toSocketFailure('boom').failure.error.code).toBe('internal');
    expect(toSocketFailure(undefined).failure.error.code).toBe('internal');
  });
});

describe('ackCallback()', () => {
  it('calls a function ack with the response', () => {
    const ack = vi.fn();
    ackCallback(ack)(ok());
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
  });

  it.each([undefined, null, 'ack', 42, { call: () => undefined }])(
    'ignores a non-function ack (%s) instead of throwing',
    (candidate) => {
      expect(() => {
        ackCallback(candidate)(ok());
      }).not.toThrow();
    },
  );
});
