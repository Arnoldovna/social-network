import { toUserSummary } from '../../db/selections.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import { pagePosition, toPage } from '../../shared/pagination/cursor.js';
import type { ChatMessageRow, ChatRepository } from './chat.repository.js';
import type { ChatMessage, ChatPage, ListChatMessagesQuery, SendChatMessage } from './chat.schema.js';

export interface ChatServiceDeps {
  repository: ChatRepository;
  /** Builds each author's public avatar URL from the stored key (ADR-0010, B-05). */
  avatarUrl: AvatarUrl;
}

export interface ChatService {
  /** One newest-first page of the global room (F-76, F-82); an undecodable cursor is 400 `invalid-cursor`. */
  listMessages(query: ListChatMessagesQuery): Promise<ChatPage>;
  /** Persists a validated message by `authorId` and returns it as the DTO every client receives (F-79, B-47). */
  send(authorId: number, input: SendChatMessage): Promise<ChatMessage>;
}

/**
 * Row -> `ChatMessage`. Picks every field explicitly, so the strict shared DTO never carries `authorId`, the avatar
 * key or any other column (B-19). `createdAt` is the database's value, as a UTC ISO string (B-47, F-108).
 */
export function toChatMessage(row: ChatMessageRow, avatarUrl: AvatarUrl): ChatMessage {
  return {
    id: row.id,
    author: toUserSummary(row.author, avatarUrl),
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createChatService({ repository, avatarUrl }: ChatServiceDeps): ChatService {
  return {
    async listMessages({ limit, cursor }) {
      // Decoded before any query: a crafted cursor is a 400, never a database error (ADR-0014).
      const rows = await repository.listMessages({ limit, ...pagePosition(cursor) });
      const page = toPage(rows, limit);
      return { items: page.items.map((row) => toChatMessage(row, avatarUrl)), nextCursor: page.nextCursor };
    },

    async send(authorId, { body }) {
      // The persisted row, never the client's payload or the app server's clock (B-47): one statement (B-75).
      const row = await repository.insertMessage({ authorId, body });
      return toChatMessage(row, avatarUrl);
    },
  };
}
