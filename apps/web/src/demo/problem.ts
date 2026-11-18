import { PROBLEM_TYPE_PREFIX } from '@app/shared';
import type { Problem, ProblemCode, ProblemErrorLocation, ProblemFieldError } from '@app/shared';
import type { z } from 'zod';

/** The titles the real API sends per status (apps/api `AppError` subclasses). */
const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  413: 'Payload too large',
  415: 'Unsupported media type',
  422: 'Validation failed',
};

/**
 * A failure of the demo backend, answered as RFC 9457 problem+json exactly like the real API (ADR-0004), so the app's
 * error handling runs unchanged.
 */
export class DemoProblem extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly detail: string | undefined;
  readonly errors: ProblemFieldError[] | undefined;

  constructor(status: number, code: ProblemCode, detail?: string, errors?: ProblemFieldError[]) {
    super(detail ?? code);
    this.name = 'DemoProblem';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.errors = errors;
  }

  toProblem(instance: string): Problem {
    return {
      type: `${PROBLEM_TYPE_PREFIX}${this.code}`,
      title: TITLES[this.status] ?? 'Error',
      status: this.status,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      instance,
      ...(this.errors === undefined ? {} : { errors: this.errors }),
    };
  }
}

/**
 * Parses `input` with a shared contract schema, the way the API's `validate` middleware does: issues in params or
 * query are a 400 `invalid-request`, issues in the body a 422 `validation-failed`, with every issue in `errors[]`.
 */
export function parseOrThrow<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  location: ProblemErrorLocation,
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const errors = result.error.issues.map((issue) => ({
    location,
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  throw location === 'body'
    ? new DemoProblem(422, 'validation-failed', 'The request body is invalid.', errors)
    : new DemoProblem(400, 'invalid-request', 'The request parameters are invalid.', errors);
}
