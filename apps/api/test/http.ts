import { randomUUID } from 'node:crypto';

import { AuthResponse, CsrfTokenResponse, type Me, type RegisterBody } from '@app/shared';
import type request from 'supertest';
import type { Response } from 'supertest';

import { CSRF_HEADER } from '../src/shared/security/csrf.js';
import { uniqueEmail } from './db.js';
import { TEST_SIGN_IN_PATH, TestSignInResponse } from './test-routes.js';

/**
 * Agent helpers for integration tests (BUILD-ORDER 1b "Test helpers", ADR-0019 §3; frozen after Phase 1b). Create the
 * agent with `request.agent(testApp.app)`: it keeps the cookies (session, CSRF) like a browser.
 *
 * Every helper that obtains a CSRF token also **stores** it as a default `x-csrf-token` header on the agent, so later
 * mutations through the agent carry it. For a "missing CSRF token → 403" case, call `.unset('x-csrf-token')` on that
 * one request, or use a second agent.
 *
 * Non-auth tests sign in with `signIn(agent, userId)` and users from `test/db.ts#insertUser`; only the auth unit's own
 * tests go through `register()`/`login()`. There is no `befriend()`: friendships come from `insertFriendship`.
 */

export type TestAgent = ReturnType<typeof request.agent>;

/** Fails with the status and the problem body, so a broken precondition explains itself in the test output. */
function expectStatus(response: Response, expected: number, step: string): void {
  if (response.status !== expected) {
    throw new Error(`${step}: expected HTTP ${String(expected)}, got ${String(response.status)}: ${response.text}`);
  }
}

function storeCsrfToken(agent: TestAgent, token: string): string {
  agent.set(CSRF_HEADER, token);
  return token;
}

/**
 * `GET /api/csrf-token` as the browser does before its first mutation: binds an anonymous session (or keeps the
 * signed-in one) and returns, and stores, the token for it.
 */
export async function csrf(agent: TestAgent): Promise<string> {
  const response = await agent.get('/api/csrf-token');
  expectStatus(response, 200, 'GET /api/csrf-token');
  return storeCsrfToken(agent, CsrfTokenResponse.parse(response.body).token);
}

/**
 * Signs the agent in as `userId` through the test-only `POST /__test/sign-in` (ADR-0019 §3): a new session id with the
 * normal TTL, like a real login. Returns, and stores, the CSRF token issued for the new session.
 */
export async function signIn(agent: TestAgent, userId: number): Promise<string> {
  const response = await agent.post(TEST_SIGN_IN_PATH).send({ userId });
  expectStatus(response, 200, `POST ${TEST_SIGN_IN_PATH}`);
  return storeCsrfToken(agent, TestSignInResponse.parse(response.body).csrfToken);
}

export interface Credentials {
  email: string;
  password: string;
}

export interface AuthResult extends Credentials {
  user: Me;
  /** The token bound to the regenerated session (already stored on the agent). */
  csrfToken: string;
  response: Response;
}

/** A valid registration body with a unique `<uuid>@example.com` and unique names; override any field. */
export function registrationBody(fields: Partial<RegisterBody> = {}): RegisterBody {
  const suffix = randomUUID().slice(0, 8);
  return {
    firstName: 'Test',
    lastName: `Registered-${suffix}`,
    email: uniqueEmail(),
    password: `test password ${suffix}`,
    ...fields,
  };
}

/**
 * The real `POST /api/auth/register` (auth unit's own tests only): fetches a CSRF token first, as the SPA does, and
 * expects 201 `AuthResponse`. Returns the credentials for a later `login()` and stores the new token.
 */
export async function register(agent: TestAgent, fields: Partial<RegisterBody> = {}): Promise<AuthResult> {
  const body = registrationBody(fields);
  await csrf(agent);
  const response = await agent.post('/api/auth/register').send(body);
  expectStatus(response, 201, 'POST /api/auth/register');
  const { user, csrfToken } = AuthResponse.parse(response.body);
  storeCsrfToken(agent, csrfToken);
  return { user, csrfToken, email: body.email, password: body.password, response };
}

/**
 * The real `POST /api/auth/login` (auth unit's own tests only): fetches a CSRF token for the current (anonymous or
 * signed-in) session first and expects 200 `AuthResponse`. Stores the token of the regenerated session.
 */
export async function login(agent: TestAgent, { email, password }: Credentials): Promise<AuthResult> {
  await csrf(agent);
  const response = await agent.post('/api/auth/login').send({ email, password });
  expectStatus(response, 200, 'POST /api/auth/login');
  const { user, csrfToken } = AuthResponse.parse(response.body);
  storeCsrfToken(agent, csrfToken);
  return { user, csrfToken, email, password, response };
}
