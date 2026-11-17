import { PROBLEM_TYPE_PREFIX, Problem, type ProblemCode, SocketError } from '@app/shared';
import request, { type Response } from 'supertest';
import { expect } from 'vitest';
import { z } from 'zod';

import { insertFriendship, insertUser, type InsertUserFields, type UserRow } from '../../../../test/db.js';
import { signIn, type TestAgent } from '../../../../test/http.js';
import { connectAs, SOCKET_WAIT_MS, type TestSocket } from '../../../../test/socket.js';
import type { TestApp } from '../../../../test/test-app.js';
import type { UserSummaryRow } from '../../../db/selections.js';
import { newAvatarKey } from '../../../shared/media/media-url.js';

/** Fixtures of the wall tests: user rows for the unit tests and a signed-in cast of users for the integration tests. */

// ---------------------------------------------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------------------------------------------

/** A user row as `userSummaryColumns` selects it; with `avatar: true` it carries a server-made key. */
export function userRow(id: number, { avatar = false }: { avatar?: boolean } = {}): UserSummaryRow {
  return {
    id,
    firstName: `First${String(id)}`,
    lastName: `Last${String(id)}`,
    avatarKey: avatar ? newAvatarKey(id) : null,
  };
}

/** Fixed user ids of the unit tests; the fake repository's post ids start at 1000, so no post id equals a user id. */
export const OWNER = 1;
export const FRIEND = 2;
export const REQUESTER = 3; // sent the owner a friend request that is still pending
export const ADDRESSEE = 4; // received a pending friend request from the owner
export const STRANGER = 5;
export const FRIEND_OF_FRIEND = 6; // a friend of FRIEND, unrelated to OWNER

/** A fixed start, so timestamps and ISO strings are the same on every run. */
export const T0 = new Date('2026-03-01T12:00:00.000Z');

/** `T0` plus `ms` milliseconds. */
export const at = (ms: number): Date => new Date(T0.getTime() + ms);

// ---------------------------------------------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------------------------------------------

export interface SignedInUser {
  user: UserRow;
  /** `request.agent(testApp.app)` signed in as `user`, with the session's CSRF token stored as default header. */
  agent: TestAgent;
}

/** Inserts a user and signs a fresh agent in as that user (test route, ADR-0019 §3). */
export async function signedInUser(testApp: TestApp, fields?: InsertUserFields): Promise<SignedInUser> {
  const user = await insertUser(testApp.db, fields);
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  return { user, agent };
}

/**
 * Every relationship the wall rules distinguish, around one wall owner (ADR-0011): an accepted friend (the friend sent
 * the request, so "either direction" is covered together with `invitedFriend`), a friend the owner invited, both kinds
 * of pending request, and a stranger who is a friend of the friend only.
 */
export interface WallCast {
  owner: SignedInUser;
  /** Asked the owner, accepted. */
  friend: SignedInUser;
  /** The owner asked, accepted. */
  invitedFriend: SignedInUser;
  /** Asked the owner, still pending. */
  requester: SignedInUser;
  /** The owner asked, still pending. */
  addressee: SignedInUser;
  /** No row with the owner; friends with `friend` (friendship is not transitive). */
  stranger: SignedInUser;
}

export async function createWallCast(testApp: TestApp): Promise<WallCast> {
  const [owner, friend, invitedFriend, requester, addressee, stranger] = await Promise.all([
    signedInUser(testApp, { firstName: 'Owner', avatar: true }),
    signedInUser(testApp, { firstName: 'Friend', avatar: true }),
    signedInUser(testApp),
    signedInUser(testApp),
    signedInUser(testApp),
    signedInUser(testApp),
  ]);
  await insertFriendship(testApp.db, friend.user.id, owner.user.id, 'accepted');
  await insertFriendship(testApp.db, owner.user.id, invitedFriend.user.id, 'accepted');
  await insertFriendship(testApp.db, requester.user.id, owner.user.id, 'pending');
  await insertFriendship(testApp.db, owner.user.id, addressee.user.id, 'pending');
  await insertFriendship(testApp.db, stranger.user.id, friend.user.id, 'accepted');
  return { owner, friend, invitedFriend, requester, addressee, stranger };
}

/**
 * Asserts an RFC 9457 answer (F-106): problem+json, the shared `Problem` contract, the status in the body, the expected
 * code as `type`, and an `instance` without query string (F-113). Returns the parsed problem for further checks.
 */
export function expectProblem(response: Response, status: number, code: ProblemCode): Problem {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json; charset=utf-8$/);
  const problem = Problem.parse(response.body);
  expect(problem).toMatchObject({ status, type: `${PROBLEM_TYPE_PREFIX}${code}` });
  expect(problem.instance).toMatch(/^\/[^?#]*$/);
  return problem;
}

// ---------------------------------------------------------------------------------------------------------------
// Socket tests
// ---------------------------------------------------------------------------------------------------------------

/** Opens sockets through `connectAs` and closes all of them after each test, so no socket outlives its test. */
export function createSocketTracker() {
  const open: TestSocket[] = [];
  return {
    async connect(testApp: TestApp, agent: TestAgent): Promise<TestSocket> {
      const socket = await connectAs(agent, testApp);
      open.push(socket);
      return socket;
    },
    closeAll(): void {
      for (const socket of open.splice(0)) socket.close();
    },
  };
}

/** The `wall:join` / `wall:leave` acknowledgement as the shared contract defines it (API.md §3), strict on both branches. */
export const WallAck = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), error: SocketError.strict() }),
]);
export type WallAck = z.infer<typeof WallAck>;

/** Emits `wall:join` or `wall:leave` with any payload and resolves with the parsed ack. */
export async function emitWall(
  socket: TestSocket,
  event: 'wall:join' | 'wall:leave',
  payload: unknown,
): Promise<WallAck> {
  // socket.io-client types a timeout ack loosely; the response is untrusted until the shared schema parsed it.
  const response: unknown = await socket.timeout(SOCKET_WAIT_MS).emitWithAck(event, payload);
  return WallAck.parse(response);
}

/** `wall:join` that must succeed (the precondition of every delivery test). */
export async function joinWall(socket: TestSocket, wallOwnerId: number): Promise<void> {
  expect(await emitWall(socket, 'wall:join', { userId: wallOwnerId })).toStrictEqual({ ok: true });
}
