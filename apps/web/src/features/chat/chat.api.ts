import { ChatMessage, ChatPage, PAGE_LIMIT_DEFAULT, SocketError } from '@app/shared';
import type { InfiniteData } from '@reduxjs/toolkit/query/react';
import { z } from 'zod';

import { baseApi } from '../../shared/api/baseApi';
import { invalidResponseError, messageFor, networkError } from '../../shared/api/problem';
import type { ApiError } from '../../shared/api/problem';
import { isLoaded, newestFirstIndex } from '../../shared/lib/newest-first';
import { bufferUntilLoaded } from '../../shared/realtime/buffer-until-loaded';
import { getSocket } from '../../shared/realtime/socket';

/** The cursor of the next older page; `null` asks for the newest page (ADR-0014). */
export type ChatCursor = string | null;
export type ChatHistory = InfiniteData<ChatPage, ChatCursor>;

/** How long a `chat:send` waits for its acknowledgement before it counts as "not sent" (F-79). */
export const SEND_TIMEOUT_MS = 10_000;

/** The `chat:send` acknowledgement as the server sends it (API.md §3), checked like every HTTP response. */
const SendAck = z.union([
  z.object({ ok: z.literal(true), message: ChatMessage }),
  z.object({ ok: z.literal(false), error: SocketError }),
]);

/**
 * Puts a message that arrived over the socket (or with the sender's own ack) into the cached history (OVERVIEW §7).
 * Every authenticated socket receives every `chat:message`, the sender's own tabs included, so a message already in any
 * page is skipped (F-79: de-duplicated by `id`). New messages belong to the newest page; they are sorted into it, so
 * an ack and a broadcast racing each other still leave the page newest first. The cursors are untouched: each one
 * points behind the oldest row of its page, which a newer message never changes.
 */
export function insertChatMessage(history: ChatHistory, message: ChatMessage): void {
  if (isLoaded(history.pages, message.id)) {
    return;
  }
  const [newest] = history.pages;
  if (newest === undefined) {
    history.pages.push({ items: [message], nextCursor: null });
    history.pageParams.push(null);
    return;
  }
  newest.items.splice(newestFirstIndex(newest.items, message), 0, message);
}

/** A failed acknowledgement as the one client error shape, so the UI shows it like any other error (ADR-0004). */
function socketApiError(error: SocketError): ApiError {
  return {
    status: 0,
    code: error.code,
    title: error.code,
    detail: error.message,
    errors: [],
    message: messageFor(error.code),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterSeconds: Math.ceil(error.retryAfterMs / 1000) }),
  };
}

/**
 * Chat history over HTTP and sending over the socket (OVERVIEW §7, API.md §2 "Chat", §3):
 *
 * - `getChatMessages`: `GET /api/chat/messages` as an infinite query, 20 messages per page, newest first, the cursor
 *   as page param (F-76, F-82, ADR-0014). Live `chat:message` events go into the newest page while the entry exists.
 *   A reconnect or a new avatar invalidates `Chat`; then only the newest page is fetched again
 *   (`refetchCachedPages: false`), so a resync never walks back through every page the user had loaded.
 * - `sendChatMessage`: `chat:send` with acknowledgement (F-78, F-79). Sending is a socket event by design (ADR-0005),
 *   wrapped as a mutation so the component gets one promise and the same `ApiError` as everywhere else. On success
 *   the confirmed message (server id and `createdAt`) is put into the history at once, whether or not the broadcast
 *   has arrived yet.
 */
export const chatApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getChatMessages: build.infiniteQuery<ChatPage, undefined, ChatCursor>({
      query: ({ pageParam }) => {
        const params = new URLSearchParams({ limit: String(PAGE_LIMIT_DEFAULT) });
        if (pageParam !== null) {
          params.set('cursor', pageParam);
        }
        return `/chat/messages?${params.toString()}`;
      },
      responseSchema: ChatPage,
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        refetchCachedPages: false,
      },
      providesTags: ['Chat'],
      // `lifecycle` is not destructured: its `updateCachedData` is declared as a method (unbound-method).
      async onCacheEntryAdded(_arg, lifecycle) {
        const socket = getSocket();
        // Messages that arrive while the first page is still loading wait instead of being lost (B-86). The page may
        // already contain them; `insertChatMessage` skips duplicates.
        const messages = bufferUntilLoaded<ChatMessage>((message) => {
          lifecycle.updateCachedData((history) => {
            insertChatMessage(history, message);
          });
        });
        const onMessage = (payload: unknown) => {
          const parsed = ChatMessage.safeParse(payload);
          if (parsed.success) {
            messages.push(parsed.data);
          }
        };
        socket.on('chat:message', onMessage);
        try {
          await lifecycle.cacheDataLoaded;
          messages.flush();
          await lifecycle.cacheEntryRemoved;
        } catch {
          // The entry was removed before its first page arrived (`cacheDataLoaded` rejects); nothing to patch.
        } finally {
          socket.off('chat:message', onMessage);
        }
      },
    }),

    sendChatMessage: build.mutation<ChatMessage, string>({
      async queryFn(body) {
        const socket = getSocket();
        if (!socket.connected) {
          // socket.io-client would buffer the event and send it after a reconnect, possibly after the user already
          // tried again; failing now keeps every message sent at most once per attempt.
          return { error: networkError() };
        }
        let response: unknown;
        try {
          response = await socket.timeout(SEND_TIMEOUT_MS).emitWithAck('chat:send', { body });
        } catch {
          // No acknowledgement in time (the connection dropped or the server is overloaded).
          return { error: networkError() };
        }
        const ack = SendAck.safeParse(response);
        if (!ack.success) {
          return { error: invalidResponseError(0) };
        }
        return ack.data.ok ? { data: ack.data.message } : { error: socketApiError(ack.data.error) };
      },
      async onQueryStarted(_body, { dispatch, queryFulfilled }) {
        let message: ChatMessage;
        try {
          ({ data: message } = await queryFulfilled);
        } catch {
          // The component marks the message "Not sent" from the mutation's own result.
          return;
        }
        dispatch(
          chatApi.util.updateQueryData('getChatMessages', undefined, (history) => {
            insertChatMessage(history, message);
          }),
        );
      },
    }),
  }),
});

export const { useGetChatMessagesInfiniteQuery, useSendChatMessageMutation } = chatApi;
