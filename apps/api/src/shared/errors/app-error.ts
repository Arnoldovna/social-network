import type { ProblemCode, ProblemFieldError } from '@app/shared';

export type ProblemExtensions = Readonly<Record<string, unknown>>;

interface AppErrorInit {
  status: number;
  /**
   * Stable, kebab-case identifier from the shared contract (API.md §4). Becomes the problem `type`, so a code outside
   * `ProblemCode` is a type error here instead of an `internal` error in the web client (ADR-0004).
   */
  code: ProblemCode;
  title: string;
  /** Human-readable, client-safe explanation. Never include secrets, SQL or stack traces. */
  detail: string;
  cause?: unknown;
  extensions?: ProblemExtensions;
}

/** Base class for every error the API deliberately exposes to clients (RFC 9457 problem details). */
export class AppError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly title: string;
  readonly extensions: ProblemExtensions;

  constructor(init: AppErrorInit) {
    super(init.detail, { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.extensions = init.extensions ?? {};
  }
}

/** One entry of the problem's `errors[]` (`location`, `path`, `message`); the shape is the shared contract's. */
export type ValidationIssue = ProblemFieldError;

/**
 * Zod issues of a request (ADR-0004): issues in params or query make it a 400 `invalid-request` (they identify the
 * resource), issues only in the body a 422 `validation-failed`. All issues are reported together in `errors[]`.
 */
export class ValidationError extends AppError {
  constructor(issues: readonly ValidationIssue[], { status }: { status: 400 | 422 }) {
    super({
      status,
      ...(status === 400
        ? { code: 'invalid-request', title: 'Bad request', detail: 'The request parameters are invalid.' }
        : { code: 'validation-failed', title: 'Validation failed', detail: 'The request body is invalid.' }),
      extensions: { errors: issues },
    });
  }
}

export class BadRequestError extends AppError {
  constructor(detail: string, code: ProblemCode = 'invalid-request') {
    super({ status: 400, code, title: 'Bad request', detail });
  }
}

/** An upload request without its file (replaces the template's `ValidationError` for a missing file). */
export class FileRequiredError extends AppError {
  constructor(detail = 'Choose a file to upload.') {
    super({ status: 400, code: 'file-required', title: 'Bad request', detail });
  }
}

export class UnauthorizedError extends AppError {
  constructor(detail = 'Authentication is required.') {
    super({ status: 401, code: 'unauthorized', title: 'Unauthorized', detail });
  }
}

export class ForbiddenError extends AppError {
  constructor(detail = 'You are not allowed to perform this action.') {
    super({ status: 403, code: 'forbidden', title: 'Forbidden', detail });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super({ status: 404, code: 'not-found', title: 'Not found', detail: `${resource} was not found.` });
  }
}

/** No default code: the service that maps a conflict knows its meaning (`email-taken`, `friendship-exists`). */
export class ConflictError extends AppError {
  constructor(detail: string, code: ProblemCode) {
    super({ status: 409, code, title: 'Conflict', detail });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(maxBytes: number) {
    super({
      status: 413,
      code: 'file-too-large',
      title: 'Payload too large',
      detail: `The upload exceeds the limit of ${String(maxBytes)} bytes.`,
      extensions: { maxBytes },
    });
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(allowed: readonly string[]) {
    super({
      status: 415,
      code: 'unsupported-media-type',
      title: 'Unsupported media type',
      detail: `Allowed types: ${allowed.join(', ')}.`,
      extensions: { allowed },
    });
  }
}

/**
 * Any limiter (HTTP or socket handshake) rejected the request: 429 `rate-limited`. express-rate-limit sets
 * `Retry-After` and the draft-8 `RateLimit` headers before its handler forwards this error, and the error handler
 * keeps headers that are already set (API.md §4, ADR-0006).
 */
export class TooManyRequestsError extends AppError {
  constructor(detail = 'Too many requests. Try again later.') {
    super({ status: 429, code: 'rate-limited', title: 'Too many requests', detail });
  }
}
