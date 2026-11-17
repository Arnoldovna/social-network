import { z } from 'zod';

/** Every `code` the API can answer with (API.md §4). `AppError.code` in the API is typed with this enum. */
export const ProblemCode = z.enum([
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
]);
export type ProblemCode = z.infer<typeof ProblemCode>;

/**
 * Problem `type` URIs are tag URIs (RFC 4151), a valid non-resolvable choice under RFC 9457:
 * `tag:arnoldovna.github.io,2026:social-network:problem:<code>`.
 */
export const PROBLEM_TYPE_PREFIX = 'tag:arnoldovna.github.io,2026:social-network:problem:';

export const ProblemErrorLocation = z.enum(['params', 'query', 'body', 'file']);
export type ProblemErrorLocation = z.infer<typeof ProblemErrorLocation>;

export const ProblemFieldError = z.object({
  location: ProblemErrorLocation,
  path: z.string(),
  message: z.string(),
});
export type ProblemFieldError = z.infer<typeof ProblemFieldError>;

/**
 * RFC 9457 problem details as the API sends them (F-106). Not strict: RFC 9457 allows extension members, and the
 * client only reads the fields below.
 */
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  errors: z.array(ProblemFieldError).optional(),
});
export type Problem = z.infer<typeof Problem>;

/**
 * Reads the machine-readable code from a problem's `type`:
 * `'tag:arnoldovna.github.io,2026:social-network:problem:email-taken'` -> `'email-taken'`.
 * Returns `null` for `about:blank` (the generic 500), for a foreign prefix and for a code outside `ProblemCode`;
 * the client treats `null` as `internal`.
 */
export function problemCode(problem: Pick<Problem, 'type'>): ProblemCode | null {
  if (!problem.type.startsWith(PROBLEM_TYPE_PREFIX)) return null;
  const parsed = ProblemCode.safeParse(problem.type.slice(PROBLEM_TYPE_PREFIX.length));
  return parsed.success ? parsed.data : null;
}
