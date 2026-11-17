import { randomUUID } from 'node:crypto';

import type { Request, Response } from 'express';
import {
  pino,
  stdSerializers,
  type DestinationStream,
  type Logger,
  type SerializedError,
  type SerializedRequest,
} from 'pino';
import { pinoHttp } from 'pino-http';

import type { Env } from '../../config/env.js';

/**
 * Paths that never reach a log line (OVERVIEW §12, F-113, B-50). Request bodies are not logged at all (pino-http
 * default); these cover headers and any object that carries credentials by mistake.
 */
const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
];

/**
 * Error properties that carry query values or credentials (B-50): pg-pool attaches the broken connection as `client`
 * (its connection parameters include the database password), Drizzle's `DrizzleQueryError` the bound `params`, and
 * Postgres errors echo values in `detail` (`Key (email)=(…) already exists`), `where` and `internalQuery`.
 */
const UNSAFE_ERROR_KEYS = new Set(['client', 'params', 'detail', 'where', 'internalQuery']);
const MAX_CAUSE_DEPTH = 10;

/** The error and its causes, outermost first (bounded, so a circular chain cannot loop). */
function causeChain(error: unknown): object[] {
  const chain: object[] = [];
  let current: unknown = error;
  while (
    typeof current === 'object' &&
    current !== null &&
    !chain.includes(current) &&
    chain.length < MAX_CAUSE_DEPTH
  ) {
    chain.push(current);
    current = 'cause' in current ? current.cause : undefined;
  }
  return chain;
}

/**
 * `DrizzleQueryError` builds its message as `Failed query: <sql>\nparams: <values>`, and the standard serializer
 * repeats the messages of the whole cause chain in `message` and `stack`. The SQL is parameterised and stays; the
 * values are replaced.
 */
function withoutQueryValues(text: string, chain: readonly object[]): string {
  return chain.reduce<string>((result, error) => {
    if (!('query' in error) || typeof error.query !== 'string' || !('params' in error)) return result;
    if (!Array.isArray(error.params)) return result;
    return result.replaceAll(`\nparams: ${error.params.join(',')}`, '\nparams: [redacted]');
  }, text);
}

function isSerializedError(value: unknown): value is SerializedError {
  return typeof value === 'object' && value !== null && 'raw' in value && value.raw instanceof Error;
}

/**
 * The `err` serializer of every logger: the standard one (type, message and stack of the whole cause chain, own
 * properties such as `code`), minus everything that can carry query values or credentials. pino passes the raw
 * error; pino-http passes the standard serializer's output, whose non-enumerable `raw` is the original.
 */
function serializeError(value: unknown): unknown {
  const serialized = value instanceof Error ? stdSerializers.err(value) : value;
  if (!isSerializedError(serialized)) return value;
  const chain = causeChain(serialized.raw);
  const safe = Object.fromEntries(Object.entries(serialized).filter(([key]) => !UNSAFE_ERROR_KEYS.has(key)));
  return {
    ...safe,
    message: withoutQueryValues(serialized.message, chain),
    stack: withoutQueryValues(serialized.stack, chain),
  };
}

/** @param destination where the JSON lines go (tests); stdout by default */
export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>, destination?: DestinationStream): Logger {
  const options = {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: { err: serializeError },
    // pino-pretty is a devDependency: only development loads it (the image runs NODE_ENV=production).
    ...(env.NODE_ENV === 'development' && destination === undefined ? { transport: { target: 'pino-pretty' } } : {}),
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

const REQUEST_ID = /^[\w-]{8,128}$/;

/** `/api/users/search?q=Mira` -> `/api/users/search`. */
function pathOnly(url: string | undefined): string {
  return url?.split('?', 1)[0] ?? '';
}

/** Probes poll every few seconds; their lines would drown everything else. */
function isHealthProbe(url: string | undefined): boolean {
  const path = pathOnly(url);
  return path.startsWith('/health/') || path === '/api/health';
}

/**
 * The request as it appears in a log line: an allow-list of the standard fields with the URL reduced to its path. The
 * standard serializer also logs the full URL and the parsed `query`, so search terms (`?q=`, people's names) would
 * reach every line of the request (F-113, B-50).
 */
function serializeRequest(request: SerializedRequest) {
  return {
    id: request.id,
    method: request.method,
    url: pathOnly(request.url),
    headers: request.headers,
    remoteAddress: request.remoteAddress,
    remotePort: request.remotePort,
  };
}

/**
 * pino-http with a request id: a well-formed incoming `x-request-id` (nginx `$request_id`) or a UUID, echoed back.
 * It writes exactly one line per request when the response finishes. The error handler (shared/http/problem.ts)
 * contributes the problem type of a failed request (`res.locals.problemType`) and, for a 5xx, the real error
 * (`res.err`), so a failure is never logged twice.
 */
export function createRequestLogger(logger: Logger) {
  return pinoHttp<Request, Response>({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    // pino-http replaces the logger's serializers with its own, so the error serializer is passed again.
    serializers: { req: serializeRequest, err: serializeError },
    // 5xx and aborted responses with an error at error, 4xx at warn, the rest at info.
    customLogLevel: (_req, res, error) => {
      if (error !== undefined || res.err !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessObject: (_req, res, value: Record<string, unknown>) => {
      const problemType: unknown = res.locals['problemType'];
      return typeof problemType === 'string' ? { ...value, problemType } : value;
    },
    autoLogging: { ignore: (req) => isHealthProbe(req.url) },
  });
}
