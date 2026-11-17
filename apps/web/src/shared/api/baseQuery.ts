import { CsrfTokenResponse } from '@app/shared';
import { fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type {
  BaseQueryApi,
  BaseQueryFn,
  FetchArgs,
  FetchBaseQueryError,
  FetchBaseQueryMeta,
  QueryReturnValue,
} from '@reduxjs/toolkit/query/react';

import { sessionExpired } from '../session/session-events';
import { clearCsrfToken, ensureCsrfToken } from './csrf';
import { invalidResponseError, networkError, toApiError } from './problem';
import type { ApiError } from './problem';

/** Header csrf-csrf reads (ADR-0005). */
export const CSRF_HEADER = 'x-csrf-token';

/** A request that hangs is reported as a network error instead of a spinner forever (B-51, F-105). */
const REQUEST_TIMEOUT_MS = 30_000;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type AppBaseQuery = BaseQueryFn<string | FetchArgs, unknown, ApiError, object, FetchBaseQueryMeta>;
type RawResult = QueryReturnValue<unknown, FetchBaseQueryError, FetchBaseQueryMeta>;

/**
 * Same origin through nginx and the Vite proxy, so the session cookie is sent and stays `SameSite=Lax` (ADR-0005).
 * `fetch` is resolved per call, so test interceptors (MSW) installed after this module loaded still apply.
 */
const rawBaseQuery = fetchBaseQuery({
  baseUrl: '/api',
  credentials: 'same-origin',
  timeout: REQUEST_TIMEOUT_MS,
  fetchFn: (input, init) => fetch(input, init),
});

/*
 * Whether the client is signed in, i.e. the `getMe` cache holds a user. `me.api.ts` registers its
 * `selectIsAuthenticated` here when it loads, because importing it would close the cycle
 * baseQuery -> me.api -> baseApi -> baseQuery. Until then nobody can be signed in (`getMe` is the only way to know),
 * so the default `false` is the correct answer, not a placeholder.
 */
let isAuthenticated: (state: unknown) => boolean = () => false;

export function setAuthenticationGuard(guard: (state: unknown) => boolean): void {
  isAuthenticated = guard;
}

interface ParsedRequest {
  args: FetchArgs;
  method: string;
  /** Path below `/api` without the query string, e.g. `/me`, `/auth/login`. */
  path: string;
}

function parseRequest(args: string | FetchArgs): ParsedRequest {
  const request = typeof args === 'string' ? { url: args } : args;
  const method = (request.method ?? 'GET').toUpperCase();
  const [pathname = ''] = request.url.split('?');
  const path = `/${pathname.replace(/^\/+|\/+$/g, '')}`;
  return { args: request, method, path };
}

/**
 * Answers that are *about* the session itself never count as "it expired" (ADR-0012, OVERVIEW §7):
 * `GET /me` is how the loaders recognise a visitor, `/csrf-token` binds an anonymous session, and `/auth/*`
 * answers 401 for wrong credentials (and for a logout racing an expiry, which `LogoutButton` handles itself).
 * `PATCH /me` is an ordinary signed-in request: its 401 is a real expiry.
 */
function isSessionProbe({ method, path }: ParsedRequest): boolean {
  return path === '/csrf-token' || path.startsWith('/auth/') || (path === '/me' && method === 'GET');
}

function withCsrfHeader(headers: FetchArgs['headers'], token: string): FetchArgs['headers'] {
  if (headers instanceof Headers) {
    const merged = new Headers(headers);
    merged.set(CSRF_HEADER, token);
    return merged;
  }
  if (Array.isArray(headers)) {
    return [...headers.filter(([name]) => name?.toLowerCase() !== CSRF_HEADER), [CSRF_HEADER, token]];
  }
  return { ...headers, [CSRF_HEADER]: token };
}

/** Maps every `fetchBaseQuery` failure onto the one `ApiError` shape. */
function toClientError(error: FetchBaseQueryError, meta: FetchBaseQueryMeta | undefined): ApiError {
  const headers = meta?.response?.headers;
  if (typeof error.status === 'number') {
    return toApiError(error.status, error.data, headers);
  }
  switch (error.status) {
    case 'FETCH_ERROR':
    case 'TIMEOUT_ERROR':
      return networkError();
    case 'PARSING_ERROR':
      // A non-JSON error page (nginx 502, proxy 413) is still that HTTP error; a non-JSON 2xx breaks the contract.
      return error.originalStatus >= 400
        ? toApiError(error.originalStatus, undefined, headers)
        : invalidResponseError(error.originalStatus);
    case 'CUSTOM_ERROR':
      return invalidResponseError(meta?.response?.status ?? 0);
  }
}

/** Carries an `ApiError` out of the shared token request (ESLint: only `Error`s are thrown). */
class CsrfTokenError extends Error {
  readonly apiError: ApiError;

  constructor(apiError: ApiError) {
    super(apiError.message);
    this.apiError = apiError;
    this.name = 'CsrfTokenError';
  }
}

async function loadCsrfToken(api: BaseQueryApi, extraOptions: object): Promise<string> {
  // Its own abort signal: the token is shared by every waiting mutation, so one aborted caller must not cancel it.
  const result = await rawBaseQuery('/csrf-token', { ...api, signal: new AbortController().signal }, extraOptions);
  if (result.error !== undefined) {
    throw new CsrfTokenError(toClientError(result.error, result.meta));
  }
  const parsed = CsrfTokenResponse.safeParse(result.data);
  if (!parsed.success) {
    throw new CsrfTokenError(invalidResponseError(result.meta?.response?.status ?? 200));
  }
  return parsed.data.token;
}

/** A finished request: the data, or the failure already mapped to `ApiError`. */
type SendResult =
  | { data: unknown; error?: undefined; meta: FetchBaseQueryMeta | undefined }
  | {
      error: ApiError;
      meta: FetchBaseQueryMeta | undefined;
      /** The failure came from `GET /csrf-token`, a session probe, not from the request itself. */
      fromTokenRequest?: true;
    };

function normalise(result: RawResult): SendResult {
  return result.error === undefined
    ? { data: result.data, meta: result.meta }
    : { error: toClientError(result.error, result.meta), meta: result.meta };
}

/** How an unsafe request sent with the session's CSRF token ended: its own result, or the token request's failure. */
export type CsrfSendOutcome<Result> = { kind: 'sent'; result: Result } | { kind: 'token-failed'; error: ApiError };

/**
 * Steps 2 and 3 of the base query for any unsafe request, so one sent outside `fetchBaseQuery` (the avatar upload's
 * `XMLHttpRequest`, the only browser API with upload progress) keeps exactly the same CSRF contract (ADR-0005,
 * ADR-0012): `sendOnce` gets the session's token, loaded lazily and shared by every waiting mutation (`csrf.ts`); when
 * `isCsrfRejection` recognises a 403 `csrf-invalid` (the session was rotated since the token was loaded), the token
 * is dropped and `sendOnce` runs once more with a fresh one. A failed token request ends it with that request's error.
 */
export async function sendWithCsrfToken<Result>(
  api: BaseQueryApi,
  extraOptions: object,
  sendOnce: (token: string) => Promise<Result>,
  isCsrfRejection: (result: Result) => boolean,
): Promise<CsrfSendOutcome<Result>> {
  const attempt = async (): Promise<CsrfSendOutcome<Result>> => {
    let token: string;
    try {
      token = await ensureCsrfToken(() => loadCsrfToken(api, extraOptions));
    } catch (error: unknown) {
      return { kind: 'token-failed', error: error instanceof CsrfTokenError ? error.apiError : networkError() };
    }
    return { kind: 'sent', result: await sendOnce(token) };
  };

  const first = await attempt();
  if (first.kind === 'sent' && isCsrfRejection(first.result)) {
    clearCsrfToken();
    return attempt();
  }
  return first;
}

/**
 * Step 5 for a request that is not a session probe, also one sent outside the base query (the avatar upload): a 401
 * dispatches `sessionExpired` only when the client was signed in when it arrived, so a visitor is never told that a
 * session expired and a signed-in user sees the message once (ADR-0012).
 */
export function reportUnauthorized(api: BaseQueryApi, error: ApiError): void {
  if (error.status === 401 && isAuthenticated(api.getState())) {
    api.dispatch(sessionExpired());
  }
}

async function send(request: ParsedRequest, api: BaseQueryApi, extraOptions: object): Promise<SendResult> {
  if (SAFE_METHODS.has(request.method)) {
    return normalise(await rawBaseQuery(request.args, api, extraOptions));
  }
  const outcome = await sendWithCsrfToken(
    api,
    extraOptions,
    async (token) => {
      const args = { ...request.args, headers: withCsrfHeader(request.args.headers, token) };
      return normalise(await rawBaseQuery(args, api, extraOptions));
    },
    (result) => result.error?.code === 'csrf-invalid',
  );
  return outcome.kind === 'sent' ? outcome.result : { error: outcome.error, meta: undefined, fromTokenRequest: true };
}

/**
 * The base query of `baseApi` (OVERVIEW §7):
 * 1. `/api` prefix, `credentials: 'same-origin'`;
 * 2. `x-csrf-token` on every `POST`/`PUT`/`PATCH`/`DELETE`, the token loaded lazily and kept in memory (`csrf.ts`);
 * 3. a 403 `csrf-invalid` drops the token and retries once with a fresh one (the session may have been rotated);
 * 4. every failure becomes an `ApiError` parsed from problem+json;
 * 5. a 401 dispatches `sessionExpired` only when the request was not a session probe **and** the client was signed in
 *    when the 401 arrived, so visitors are never told their session expired and the message appears once.
 */
export const baseQuery: AppBaseQuery = async (args, api, extraOptions) => {
  const request = parseRequest(args);
  const result = await send(request, api, extraOptions);

  const { meta } = result;
  if (result.error === undefined) {
    return meta === undefined ? { data: result.data } : { data: result.data, meta };
  }

  const { error } = result;
  if (result.fromTokenRequest !== true && !isSessionProbe(request)) {
    reportUnauthorized(api, error);
  }
  return meta === undefined ? { error } : { error, meta };
};
