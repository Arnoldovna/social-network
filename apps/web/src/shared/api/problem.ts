import { AVATAR_MAX_BYTES, Problem, problemCode } from '@app/shared';
import type { ProblemCode, ProblemFieldError } from '@app/shared';

/**
 * Codes the client adds to the API's catalogue (API.md §4): `network` when no response arrived at all (offline, DNS,
 * connection reset) and `invalid-response` when a response did not match the shared Zod contract.
 */
export type ClientErrorCode = 'network' | 'invalid-response';
export type ApiErrorCode = ProblemCode | ClientErrorCode;

/**
 * The single error shape of every endpoint built on `baseApi` (the base query's error type), parsed from RFC 9457
 * problem+json (ADR-0004, F-106). Components branch on `code`, show `message`, and map `errors` onto form fields.
 */
export interface ApiError {
  /** HTTP status; `0` when no response arrived (`code: 'network'`). */
  status: number;
  code: ApiErrorCode;
  /** The problem's `title`, or a generic one when the body was not a problem. */
  title: string;
  /** The server's `detail`, as sent. It can be technical ("The upload exceeds …"), so the UI shows `message`. */
  detail: string | undefined;
  /** Field errors of a 400/422 (`location`, `path`, `message`); empty otherwise. */
  errors: ProblemFieldError[];
  /** One plain English sentence for the UI (maw-design-system §10: what happened and what to do next). */
  message: string;
  /** Seconds from a 429's `Retry-After` header, when present. */
  retryAfterSeconds?: number;
}

/** "2 MB": the upload limit from the shared contract, so the 413 sentence and the upload hint follow it. */
export const AVATAR_MAX_SIZE_LABEL = `${String(AVATAR_MAX_BYTES / (1024 * 1024))} MB`;

/**
 * The user-facing sentence per code. A `Record` over every code, so a new `ProblemCode` in the contract is a type
 * error here until it has copy. Copy from FEATURES.md where it fixes one (F-10, F-15, F-22, F-36, F-42).
 */
const MESSAGES: Record<ApiErrorCode, string> = {
  network: 'The server could not be reached. Check your connection and try again.',
  'invalid-response': 'The server sent an unexpected answer. Please try again.',
  internal: 'Something went wrong on our side. Please try again.',
  'invalid-request': 'This request could not be processed. Reload the page and try again.',
  'validation-failed': 'Some fields need your attention.',
  'invalid-cursor': 'Older entries could not be loaded. Reload the page and try again.',
  unauthorized: 'Your session has expired. Please log in again.',
  'invalid-credentials': 'Email or password is incorrect.',
  'csrf-invalid': 'Your session could not be verified. Reload the page and try again.',
  forbidden: 'You are not allowed to do that.',
  'wall-forbidden': 'Only friends can see this wall.',
  'wall-write-forbidden': 'Only friends can write on this wall.',
  'post-delete-forbidden': 'Only the author or the wall owner can delete this post.',
  'not-found': 'This could not be found. It may have been removed.',
  'user-not-found': 'This user does not exist.',
  'post-not-found': 'This post no longer exists.',
  'friend-request-not-found': 'This friend request no longer exists.',
  'friendship-not-found': 'This friendship no longer exists.',
  'email-taken': 'An account with this email already exists.',
  'friendship-exists': 'There is already a friend request between you two.',
  'cannot-befriend-self': 'You cannot send a friend request to yourself.',
  'file-required': 'Choose an image to upload.',
  'file-too-large': `The image must be ${AVATAR_MAX_SIZE_LABEL} or smaller.`,
  'unsupported-media-type': 'Please choose a JPEG, PNG, WebP or GIF image.',
  'rate-limited': 'Too many requests. Wait a moment and try again.',
};

/** The fallback code for a response that carries no usable problem `type` (HTML error page, `about:blank`). */
function codeForStatus(status: number): ProblemCode {
  switch (status) {
    case 400:
      return 'invalid-request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not-found';
    case 413:
      // nginx answers an oversized body itself; its page is never JSON (API.md §4, ADR-0012).
      return 'file-too-large';
    case 415:
      return 'unsupported-media-type';
    case 422:
      return 'validation-failed';
    case 429:
      return 'rate-limited';
    default:
      return 'internal';
  }
}

/** `Retry-After` as delta-seconds; the HTTP-date form is not used by the API's limiters (draft-8 headers). */
function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || !/^\d+$/.test(value.trim())) {
    return undefined;
  }
  return Number(value.trim());
}

export function messageFor(code: ApiErrorCode): string {
  return MESSAGES[code];
}

/**
 * Turns an HTTP error response into an `ApiError`. The body is parsed with the shared `Problem` schema; a body that is
 * not a problem (proxy page, empty 502) still yields a typed error from the status alone, so the UI never shows raw
 * server output (B-32). `problemCode()` returns `null` for `about:blank` (the generic 500), so the status decides:
 * `internal` for a 5xx.
 */
export function toApiError(status: number, body: unknown, headers?: Pick<Headers, 'get'>): ApiError {
  const parsed = Problem.safeParse(body);
  const problem = parsed.success ? parsed.data : undefined;
  const code: ApiErrorCode = (problem === undefined ? null : problemCode(problem)) ?? codeForStatus(status);
  const retryAfterSeconds = parseRetryAfter(headers?.get('retry-after'));

  return {
    status,
    code,
    title: problem?.title ?? 'Request failed',
    detail: problem?.detail,
    errors: problem?.errors ?? [],
    message: MESSAGES[code],
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

/** An error the client itself detected: no problem body, so no `detail` and no field errors. */
function clientError(status: number, code: ClientErrorCode, title: string): ApiError {
  return { status, code, title, detail: undefined, errors: [], message: MESSAGES[code] };
}

/** An error without any HTTP response: `fetch` rejected or timed out. */
export function networkError(): ApiError {
  return clientError(0, 'network', 'Network error');
}

/** A response that arrived but does not match the shared contract (unparsable JSON or a failed Zod schema). */
export function invalidResponseError(status: number): ApiError {
  return clientError(status, 'invalid-response', 'Invalid response');
}

export function isApiError(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof ApiError, unknown>>;
  return (
    typeof candidate.status === 'number' &&
    typeof candidate.code === 'string' &&
    Object.hasOwn(MESSAGES, candidate.code) &&
    typeof candidate.message === 'string' &&
    Array.isArray(candidate.errors)
  );
}

/** `true` when `error` is an `ApiError` with this code, e.g. `hasErrorCode(error, 'email-taken')` (F-10). */
export function hasErrorCode(error: unknown, code: ApiErrorCode): boolean {
  return isApiError(error) && error.code === code;
}

/**
 * The sentence to show for any error a hook or `unwrap()` produced: an `ApiError`'s message, otherwise the generic
 * one (a `SerializedError` from a thrown bug is never shown verbatim).
 */
export function errorMessage(error: unknown, fallback: string = MESSAGES.internal): string {
  return isApiError(error) ? error.message : fallback;
}

/**
 * Body field errors keyed by their path (`'password'`, `'body'`), first message per field, for react-hook-form's
 * `setError` (F-11). Issues on params, query or the uploaded file are not form fields and are left out.
 */
export function bodyFieldErrors(error: unknown): Record<string, string> {
  if (!isApiError(error)) {
    return {};
  }
  const fields: Record<string, string> = {};
  for (const issue of error.errors) {
    if (issue.location === 'body' && !Object.hasOwn(fields, issue.path)) {
      fields[issue.path] = issue.message;
    }
  }
  return fields;
}
