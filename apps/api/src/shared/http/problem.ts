import { PROBLEM_TYPE_PREFIX, type Problem, type ProblemCode } from '@app/shared';
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import multer from 'multer';

import { AppError, NotFoundError } from '../errors/app-error.js';

/**
 * RFC 9457 problem details as the API sends them: the shared contract's `Problem` plus extension members (RFC 9457
 * allows them next to the standard fields). The `type` prefix comes from the contract too, so the server can never
 * emit a type the web client's `problemCode()` does not recognise (ADR-0003, ADR-0004).
 */
export type ProblemDetails = Problem & Readonly<Record<string, unknown>>;

const STATUS_TITLES: Readonly<Record<number, string>> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  413: 'Payload too large',
  415: 'Unsupported media type',
  422: 'Validation failed',
  429: 'Too many requests',
  500: 'Internal server error',
};

/** csrf-csrf's `invalidCsrfTokenError` carries this code (ADR-0004, ADR-0005). */
const CSRF_ERROR_CODE = 'EBADCSRFTOKEN';

/** Errors created by `http-errors` (body-parser, csrf-csrf, ...) carry `status` and `expose`. */
interface HttpErrorLike {
  status: number;
  expose: boolean;
  message: string;
  code?: unknown;
}

function isHttpErrorLike(error: unknown): error is HttpErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number' &&
    'expose' in error &&
    typeof error.expose === 'boolean'
  );
}

/** The request path without the query string, so search terms (`?q=`) never reach a problem body (F-113). */
function instanceOf(req: Request): string {
  return req.baseUrl + req.path;
}

function coded(status: number, code: ProblemCode, req: Request, detail?: string): ProblemDetails {
  return {
    type: `${PROBLEM_TYPE_PREFIX}${code}`,
    title: STATUS_TITLES[status] ?? 'Error',
    status,
    ...(detail === undefined ? {} : { detail }),
    instance: instanceOf(req),
  };
}

/**
 * Maps any error to the problem the client receives (API.md §4). Every 4xx carries a `ProblemCode`; only the generic
 * 500 is `about:blank`, with a fixed detail (the real error goes to the log only, F-106).
 */
export function toProblem(error: unknown, req: Request): ProblemDetails {
  if (error instanceof AppError) {
    return {
      ...error.extensions,
      type: `${PROBLEM_TYPE_PREFIX}${error.code}`,
      title: error.title,
      status: error.status,
      detail: error.message,
      instance: instanceOf(req),
    };
  }
  if (error instanceof multer.MulterError) {
    return error.code === 'LIMIT_FILE_SIZE'
      ? coded(413, 'file-too-large', req, error.message)
      : coded(400, 'invalid-request', req, error.message);
  }
  if (isHttpErrorLike(error) && error.status >= 400 && error.status < 500) {
    if (error.code === CSRF_ERROR_CODE) {
      return coded(403, 'csrf-invalid', req, 'The CSRF token is missing or invalid. Reload and try again.');
    }
    // body-parser: malformed JSON (400), too large (413), unsupported charset or encoding (415); the status stays.
    return coded(error.status, 'invalid-request', req, error.expose ? error.message : undefined);
  }
  return {
    type: 'about:blank',
    title: STATUS_TITLES[500] ?? 'Internal server error',
    status: 500,
    detail: 'An unexpected error occurred.',
    instance: instanceOf(req),
  };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
};

/** pino-http types `res.err` as an `Error`; a thrown non-Error value is wrapped so the log still names it. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Must be registered last. Express 5 forwards rejected promises from async handlers here, so handlers never need
 * try/catch or an asyncHandler wrapper.
 *
 * It writes no log line of its own: the request logger (shared/logging/logger.ts) writes exactly one line per request
 * when the response finishes. This handler hands it the problem type and, for a 5xx, the real error with its stack
 * (`res.err`), so a 500 is logged once with the real cause instead of a second, synthetic "failed with status code"
 * error.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    // Express' final handler aborts the half-sent response; the request line still carries the cause.
    res.err = asError(error);
    next(error);
    return;
  }
  const problem = toProblem(error, req);
  res.locals['problemType'] = problem.type;
  if (problem.status >= 500) res.err = asError(error);
  res.status(problem.status).type('application/problem+json').json(problem);
};
