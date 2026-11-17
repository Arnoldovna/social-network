import { describe, expect, it } from 'vitest';

import { Problem, PROBLEM_TYPE_PREFIX, ProblemCode, problemCode } from '../index.js';

// F-106: errors are RFC 9457 problem+json with a machine-readable code in `type`.
describe('problemCode', () => {
  it('uses the documented tag URI prefix', () => {
    expect(PROBLEM_TYPE_PREFIX).toBe('tag:arnoldovna.github.io,2026:social-network:problem:');
  });

  it.each(ProblemCode.options)('reads %j back from its type URI', (code) => {
    expect(problemCode({ type: `${PROBLEM_TYPE_PREFIX}${code}` })).toBe(code);
  });

  it.each([
    ['the generic 500', 'about:blank'],
    ['an unknown code', `${PROBLEM_TYPE_PREFIX}teapot`],
    ['an empty code', PROBLEM_TYPE_PREFIX],
    ['another app', 'tag:arnoldovna.github.io,2026:imageboard:problem:not-found'],
    ['a URL', 'https://example.com/problems/not-found'],
    ['a bare code', 'not-found'],
    ['a code with a suffix', `${PROBLEM_TYPE_PREFIX}not-found/extra`],
  ])('returns null for %s', (_label, type) => {
    expect(problemCode({ type })).toBeNull();
  });
});

describe('ProblemCode', () => {
  it('contains every code of the problem catalogue (API.md §4)', () => {
    expect(new Set(ProblemCode.options)).toEqual(
      new Set([
        'invalid-request',
        'validation-failed',
        'invalid-cursor',
        'unauthorized',
        'invalid-credentials',
        'csrf-invalid',
        'forbidden',
        'wall-forbidden',
        'wall-write-forbidden',
        'post-delete-forbidden',
        'not-found',
        'user-not-found',
        'post-not-found',
        'friend-request-not-found',
        'friendship-not-found',
        'email-taken',
        'friendship-exists',
        'cannot-befriend-self',
        'file-required',
        'file-too-large',
        'unsupported-media-type',
        'rate-limited',
        'internal',
      ]),
    );
  });
});

describe('Problem', () => {
  const example = {
    type: `${PROBLEM_TYPE_PREFIX}validation-failed`,
    title: 'Validation failed',
    status: 422,
    detail: 'The request body is invalid.',
    instance: '/api/auth/register',
    errors: [{ location: 'body', path: 'password', message: 'Use at least 12 characters.' }],
  };

  it('parses the documented example', () => {
    const problem = Problem.parse(example);
    expect(problem).toEqual(example);
    expect(problemCode(problem)).toBe('validation-failed');
  });

  it('parses the generic 500 without optional members', () => {
    const generic = { type: 'about:blank', title: 'Internal server error', status: 500 };
    expect(Problem.parse(generic)).toEqual(generic);
    expect(problemCode(Problem.parse(generic))).toBeNull();
  });

  it('tolerates RFC 9457 extension members', () => {
    expect(Problem.safeParse({ ...example, retryAfter: 30 }).success).toBe(true);
  });

  it.each([
    ['an unknown error location', { ...example, errors: [{ location: 'header', path: 'x', message: 'y' }] }],
    ['a non-integer status', { ...example, status: 422.5 }],
    ['a missing title', { type: example.type, status: 422 }],
    ['a non-JSON body', '<html>Bad gateway</html>'],
  ])('rejects %s', (_label, input) => {
    expect(Problem.safeParse(input).success).toBe(false);
  });
});
