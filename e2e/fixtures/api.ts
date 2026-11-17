import { randomUUID } from 'node:crypto';

import { request, type APIRequestContext, type APIResponse } from '@playwright/test';

/**
 * Test data through the real API (ADR-0016 "E2E data"): every mutation journey registers its own users with a unique
 * `e2e+<uuid>@example.com`, optionally makes them friends, and opens pages that reuse the API session's cookies
 * (`storageState`). Nothing here logs in as a seeded account or touches the database directly.
 *
 * The response shapes mirror `packages/shared` (API.md §1). The root workspace does not depend on `@app/shared`, so
 * they are checked here by small guards instead of the Zod schemas; a contract drift fails the fixture loudly.
 */

/** Header the API reads the CSRF token from (API.md "CSRF", `apps/api/src/shared/security/csrf.ts`). */
export const CSRF_HEADER = 'x-csrf-token';

export type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;

export interface UserSummary {
  id: number;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
}

export interface Me extends UserSummary {
  bio: string | null;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface RegisterFields extends Credentials {
  firstName: string;
  lastName: string;
}

export type FriendshipState = 'none' | 'pending_outgoing' | 'pending_incoming' | 'friends';

export interface FriendshipChange {
  userId: number;
  state: FriendshipState;
}

export type JsonBody = Record<string, unknown> | readonly unknown[];

/**
 * One cookie jar against the stack (a browser profile without a browser). It remembers the CSRF token of its current
 * session and sends it on every mutation; pass `{ csrf: false }` to send a mutation without it (expected 403).
 */
export interface ApiClient {
  readonly request: APIRequestContext;
  /** The token bound to the current session, or null before the first `refreshCsrfToken()`/register/login. */
  csrfToken(): string | null;
  /** `GET /api/csrf-token`: binds an anonymous session if there is none and stores the token for it. */
  refreshCsrfToken(): Promise<string>;
  /** Replaces the stored token, e.g. with the one register/login returned for the regenerated session (F-18). */
  useCsrfToken(token: string): void;
  get(path: string): Promise<APIResponse>;
  post(path: string, body?: JsonBody, options?: MutationOptions): Promise<APIResponse>;
  patch(path: string, body?: JsonBody, options?: MutationOptions): Promise<APIResponse>;
  delete(path: string, options?: MutationOptions): Promise<APIResponse>;
  /** Cookies (session, CSRF) in the shape `browser.newContext({ storageState })` accepts. */
  storageState(): Promise<StorageState>;
  dispose(): Promise<void>;
}

export interface MutationOptions {
  /** false sends the request without `x-csrf-token`. */
  csrf?: boolean;
}

/** A registered user with its own signed-in API client. The client and pages opened for the user share one session. */
export interface E2EUser extends RegisterFields {
  id: number;
  me: Me;
  api: ApiClient;
}

/** Fails with the status and body, so a broken precondition explains itself in the Playwright report. */
export async function expectStatus(response: APIResponse, expected: number, step: string): Promise<void> {
  if (response.status() !== expected) {
    throw new Error(
      `${step}: expected HTTP ${String(expected)}, got ${String(response.status())}: ${await response.text()}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function contractError(step: string, body: unknown): Error {
  return new Error(`${step}: response does not match the API contract: ${JSON.stringify(body)}`);
}

function parseMe(value: unknown, step: string): Me {
  if (
    isRecord(value) &&
    isPositiveInt(value['id']) &&
    typeof value['firstName'] === 'string' &&
    typeof value['lastName'] === 'string' &&
    isNullableString(value['avatarUrl']) &&
    isNullableString(value['bio'])
  ) {
    return {
      id: value['id'],
      firstName: value['firstName'],
      lastName: value['lastName'],
      avatarUrl: value['avatarUrl'],
      bio: value['bio'],
    };
  }
  throw contractError(step, value);
}

function parseToken(value: unknown, key: 'token' | 'csrfToken', step: string): string {
  if (isRecord(value)) {
    const token = value[key];
    if (typeof token === 'string' && token.length > 0) return token;
  }
  throw contractError(step, value);
}

const FRIENDSHIP_STATES: readonly FriendshipState[] = ['none', 'pending_outgoing', 'pending_incoming', 'friends'];

function parseFriendshipChange(value: unknown, step: string): FriendshipChange {
  if (isRecord(value) && isPositiveInt(value['userId'])) {
    const state = FRIENDSHIP_STATES.find((candidate) => candidate === value['state']);
    if (state) return { userId: value['userId'], state };
  }
  throw contractError(step, value);
}

/** A fresh cookie jar against `baseURL` (the stack behind nginx, `E2E_BASE_URL`). Dispose it when done. */
export async function createApiClient(baseURL: string): Promise<ApiClient> {
  const context = await request.newContext({ baseURL });
  let token: string | null = null;

  const headers = (options: MutationOptions = {}): Record<string, string> => {
    if (options.csrf === false) return {};
    if (token === null) throw new Error('No CSRF token yet: call refreshCsrfToken(), register or log in first.');
    return { [CSRF_HEADER]: token };
  };

  const mutation = (body: JsonBody | undefined, options: MutationOptions | undefined) => ({
    headers: headers(options),
    ...(body === undefined ? {} : { data: body }),
  });

  return {
    request: context,
    csrfToken: () => token,
    async refreshCsrfToken() {
      const response = await context.get('/api/csrf-token');
      await expectStatus(response, 200, 'GET /api/csrf-token');
      token = parseToken(await response.json(), 'token', 'GET /api/csrf-token');
      return token;
    },
    useCsrfToken(next) {
      token = next;
    },
    get: (path) => context.get(path),
    post: (path, body, options) => context.post(path, mutation(body, options)),
    patch: (path, body, options) => context.patch(path, mutation(body, options)),
    delete: (path, options) => context.delete(path, { headers: headers(options) }),
    storageState: () => context.storageState(),
    dispose: () => context.dispose(),
  };
}

/**
 * Valid registration fields that no other test (or parallel worker) uses: `e2e+<uuid>@example.com`, a unique last
 * name (search and online-list assertions look for it, never for counts) and a random 12+ character password.
 */
export function newUserFields(fields: Partial<RegisterFields> = {}): RegisterFields {
  const id = randomUUID();
  const suffix = id.slice(0, 8);
  return {
    firstName: 'Erin',
    lastName: `E2E-${suffix}`,
    email: `e2e+${id}@example.com`,
    password: `e2e password ${randomUUID()}`,
    ...fields,
  };
}

/**
 * Registers through the real `POST /api/auth/register` (CSRF token first, as the SPA does) and keeps the client signed
 * in. The token the response carries replaces the anonymous one, because register regenerates the session (F-18).
 */
export async function registerUser(baseURL: string, fields: Partial<RegisterFields> = {}): Promise<E2EUser> {
  const body = newUserFields(fields);
  const api = await createApiClient(baseURL);
  try {
    await api.refreshCsrfToken();
    const response = await api.post('/api/auth/register', { ...body });
    await expectStatus(response, 201, 'POST /api/auth/register');
    const json: unknown = await response.json();
    api.useCsrfToken(parseToken(json, 'csrfToken', 'POST /api/auth/register'));
    const me = parseMe(isRecord(json) ? json['user'] : undefined, 'POST /api/auth/register');
    return { ...body, id: me.id, me, api };
  } catch (error) {
    await api.dispose();
    throw error;
  }
}

/** Logs an existing user in on a fresh client (a second device): a new session with its own CSRF token. */
export async function logIn(baseURL: string, credentials: Credentials): Promise<ApiClient> {
  const api = await createApiClient(baseURL);
  try {
    await api.refreshCsrfToken();
    const response = await api.post('/api/auth/login', { email: credentials.email, password: credentials.password });
    await expectStatus(response, 200, 'POST /api/auth/login');
    api.useCsrfToken(parseToken(await response.json(), 'csrfToken', 'POST /api/auth/login'));
    return api;
  } catch (error) {
    await api.dispose();
    throw error;
  }
}

/** `requester` sends a friend request to `addressee`; the request stays pending (F-45, F-46). */
export async function requestFriendship(requester: E2EUser, addressee: E2EUser): Promise<FriendshipChange> {
  const step = `POST /api/friendships (${String(requester.id)} -> ${String(addressee.id)})`;
  const response = await requester.api.post('/api/friendships', { userId: addressee.id });
  await expectStatus(response, 201, step);
  const change = parseFriendshipChange(await response.json(), step);
  if (change.state !== 'pending_outgoing') throw contractError(step, change);
  return change;
}

/** Makes `a` and `b` friends through the API: `a` requests, `b` accepts (F-48). */
export async function befriend(a: E2EUser, b: E2EUser): Promise<void> {
  await requestFriendship(a, b);
  const step = `POST /api/friendships/${String(a.id)}/accept (by ${String(b.id)})`;
  const response = await b.api.post(`/api/friendships/${String(a.id)}/accept`);
  await expectStatus(response, 200, step);
  const change = parseFriendshipChange(await response.json(), step);
  if (change.state !== 'friends') throw contractError(step, change);
}
