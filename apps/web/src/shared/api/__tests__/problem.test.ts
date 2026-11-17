import { PROBLEM_TYPE_PREFIX, ProblemCode } from '@app/shared';
import { describe, expect, it } from 'vitest';

import {
  bodyFieldErrors,
  errorMessage,
  hasErrorCode,
  invalidResponseError,
  isApiError,
  messageFor,
  networkError,
  toApiError,
} from '../problem';

const problem = (code: string, status: number, extra: Record<string, unknown> = {}) => ({
  type: `${PROBLEM_TYPE_PREFIX}${code}`,
  title: 'Title from the API',
  status,
  ...extra,
});

describe('toApiError', () => {
  it('reads code, title, detail and field errors from problem+json (F-106)', () => {
    const error = toApiError(
      422,
      problem('validation-failed', 422, {
        detail: 'The request body is invalid.',
        instance: '/api/auth/register',
        errors: [{ location: 'body', path: 'password', message: 'Use at least 12 characters.' }],
      }),
    );

    expect(error).toEqual({
      status: 422,
      code: 'validation-failed',
      title: 'Title from the API',
      detail: 'The request body is invalid.',
      errors: [{ location: 'body', path: 'password', message: 'Use at least 12 characters.' }],
      message: 'Some fields need your attention.',
    });
  });

  it('uses the copy FEATURES.md fixes for its codes', () => {
    expect(toApiError(409, problem('email-taken', 409)).message).toBe('An account with this email already exists.');
    expect(toApiError(401, problem('invalid-credentials', 401)).message).toBe('Email or password is incorrect.');
    expect(toApiError(401, problem('unauthorized', 401)).message).toBe(
      'Your session has expired. Please log in again.',
    );
    expect(toApiError(404, problem('user-not-found', 404)).message).toBe('This user does not exist.');
    expect(toApiError(413, problem('file-too-large', 413)).message).toBe('The image must be 2 MB or smaller.');
  });

  it('never shows a technical server detail as the message', () => {
    const error = toApiError(413, problem('file-too-large', 413, { detail: 'The upload exceeds 2097152 bytes.' }));
    expect(error.detail).toBe('The upload exceeds 2097152 bytes.');
    expect(error.message).toBe('The image must be 2 MB or smaller.');
  });

  it('treats about:blank (the generic 500) as internal', () => {
    const error = toApiError(500, {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred.',
    });
    expect(error.code).toBe('internal');
    expect(error.message).toBe('Something went wrong on our side. Please try again.');
  });

  it('falls back to the status for a foreign or unknown problem type', () => {
    expect(toApiError(404, { type: 'https://example.com/not-ours', title: 'Nope', status: 404 }).code).toBe(
      'not-found',
    );
    expect(toApiError(403, problem('made-up-code', 403)).code).toBe('forbidden');
  });

  it.each([
    [400, 'invalid-request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [413, 'file-too-large'],
    [415, 'unsupported-media-type'],
    [422, 'validation-failed'],
    [429, 'rate-limited'],
    [500, 'internal'],
    [502, 'internal'],
  ])('maps a %i without a problem body to %s (proxy pages, B-32)', (status, code) => {
    const error = toApiError(status, '<html><body>Bad Gateway</body></html>');
    expect(error.code).toBe(code);
    expect(error.title).toBe('Request failed');
    expect(error.detail).toBeUndefined();
    expect(error.errors).toEqual([]);
  });

  it('reads Retry-After seconds from a 429', () => {
    const headers = new Headers({ 'retry-after': '42' });
    expect(toApiError(429, problem('rate-limited', 429), headers).retryAfterSeconds).toBe(42);
  });

  it('ignores a Retry-After that is not delta-seconds', () => {
    const headers = new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' });
    expect(toApiError(429, problem('rate-limited', 429), headers)).not.toHaveProperty('retryAfterSeconds');
  });
});

describe('messages', () => {
  it('has a plain sentence for every code of the contract', () => {
    for (const code of [...ProblemCode.options, 'network', 'invalid-response'] as const) {
      const message = messageFor(code);
      expect(message, code).toMatch(/^[A-Z].*\.$/);
      expect(message, code).not.toContain('!');
    }
  });

  it('builds network and invalid-response errors', () => {
    expect(networkError()).toMatchObject({ status: 0, code: 'network', errors: [] });
    expect(invalidResponseError(200)).toMatchObject({ status: 200, code: 'invalid-response' });
  });
});

describe('guards and helpers', () => {
  const emailTaken = toApiError(409, problem('email-taken', 409));

  it('recognises ApiErrors and nothing else', () => {
    expect(isApiError(emailTaken)).toBe(true);
    expect(isApiError(networkError())).toBe(true);
    expect(isApiError({ status: 409, data: {} })).toBe(false);
    expect(isApiError({ ...emailTaken, code: 'made-up' })).toBe(false);
    expect(isApiError(new Error('boom'))).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError('email-taken')).toBe(false);
  });

  it('checks a code', () => {
    expect(hasErrorCode(emailTaken, 'email-taken')).toBe(true);
    expect(hasErrorCode(emailTaken, 'validation-failed')).toBe(false);
    expect(hasErrorCode(undefined, 'email-taken')).toBe(false);
  });

  it('gives the message of an ApiError and a generic sentence for anything else', () => {
    expect(errorMessage(emailTaken)).toBe('An account with this email already exists.');
    expect(errorMessage({ name: 'SerializedError', message: 'Cannot read properties of undefined' })).toBe(
      'Something went wrong on our side. Please try again.',
    );
    expect(errorMessage(undefined, 'The post could not be deleted.')).toBe('The post could not be deleted.');
  });

  it('maps body field errors for forms, first message per field (F-11)', () => {
    const error = toApiError(
      422,
      problem('validation-failed', 422, {
        errors: [
          { location: 'body', path: 'password', message: 'Use at least 12 characters.' },
          { location: 'body', path: 'password', message: 'A second message for the same field.' },
          { location: 'body', path: 'email', message: 'Please enter a valid email address.' },
          { location: 'query', path: 'q', message: 'Too long.' },
          { location: 'file', path: 'avatar', message: 'The image is too large.' },
        ],
      }),
    );

    expect(bodyFieldErrors(error)).toEqual({
      password: 'Use at least 12 characters.',
      email: 'Please enter a valid email address.',
    });
    expect(bodyFieldErrors(new Error('boom'))).toEqual({});
  });
});
