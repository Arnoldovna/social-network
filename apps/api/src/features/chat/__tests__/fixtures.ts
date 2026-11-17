import { ChatMessage, ChatPage, SocketError } from '@app/shared';
import { count, eq } from 'drizzle-orm';
import request from 'supertest';
import { z } from 'zod';

import { insertUser, type InsertUserFields, type UserRow } from '../../../../test/db.js';
import { signIn, type TestAgent } from '../../../../test/http.js';
import { connectAs, SOCKET_WAIT_MS, type TestSocket } from '../../../../test/socket.js';
import type { TestApp } from '../../../../test/test-app.js';
import type { Database } from '../../../db/client.js';
import { chatMessages } from '../../../db/schema/index.js';

/**
 * Integration fixtures of the chat tests (BUILD-ORDER rule 5): users signed in through the test-only route (`signIn`,
 * ADR-0019 §3), their sockets, `chat:send` with a parsed ack, and the chat read over HTTP. The unit tests' row
 * builders live in `fakes.ts`, so unit tests never load the integration harness.
 */

// ---------------------------------------------------------------------------------------------------------------
// Integration: users, agents, sockets
// ---------------------------------------------------------------------------------------------------------------

export interface Chatter {
  user: UserRow;
  agent: TestAgent;
}

/** A new user and an agent signed in as that user (fresh session with the normal TTL). */
export async function signedInChatter(testApp: TestApp, fields: InsertUserFields = {}): Promise<Chatter> {
  const user = await insertUser(testApp.db, fields);
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  return { user, agent };
}

/** Collects every client socket a test opens, so `afterEach` can close them and no test leaks connections. */
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

/** The `chat:send` acknowledgement as the shared contract defines it (API.md §3), strict on the success branch. */
export const ChatSendAck = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), message: ChatMessage }),
  z.strictObject({ ok: z.literal(false), error: SocketError.strict() }),
]);
export type ChatSendAck = z.infer<typeof ChatSendAck>;

/** Emits `chat:send` and resolves with the parsed ack; rejects when the server does not answer in time. */
export async function sendChat(socket: TestSocket, payload: unknown): Promise<ChatSendAck> {
  // socket.io-client types a timeout ack loosely; the response is untrusted until the shared schema parsed it.
  const response: unknown = await socket.timeout(SOCKET_WAIT_MS).emitWithAck('chat:send', payload);
  return ChatSendAck.parse(response);
}

/** A successful `chat:send`: fails the test with the ack's error otherwise. */
export async function sendChatOk(socket: TestSocket, body: string): Promise<ChatMessage> {
  const ack = await sendChat(socket, { body });
  if (!ack.ok) throw new Error(`chat:send failed: ${ack.error.code} (${ack.error.message})`);
  return ack.message;
}

// ---------------------------------------------------------------------------------------------------------------
// Integration: reading the chat
// ---------------------------------------------------------------------------------------------------------------

/** `GET /api/chat/messages` as `agent`, expecting 200 and a strict `ChatPage`. */
export async function fetchChatPage(agent: TestAgent, query: { limit?: number; cursor?: string } = {}) {
  const response = await agent.get('/api/chat/messages').query(query).expect(200);
  return ChatPage.parse(response.body);
}

/** Follows `nextCursor` from the first page to the last; every page is returned, in request order. */
export async function fetchAllChatPages(agent: TestAgent, limit: number): Promise<ChatPage[]> {
  const pages: ChatPage[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchChatPage(agent, { limit, ...(cursor === undefined ? {} : { cursor }) });
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
    // 25 rows at limit 10 need three pages; a runaway cursor must fail the test instead of looping.
    if (pages.length > 100) throw new Error('fetchAllChatPages: more than 100 pages');
  } while (cursor !== undefined);
  return pages;
}

/** How many messages `authorId` has in the database (proves "nothing was persisted"). */
export async function chatMessageCount(db: Database, authorId: number): Promise<number> {
  const [row] = await db.select({ total: count() }).from(chatMessages).where(eq(chatMessages.authorId, authorId));
  return row?.total ?? 0;
}
