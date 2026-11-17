import { desc, eq } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { keysetAfter } from '../../db/keyset.js';
import { chatMessages, users } from '../../db/schema/index.js';
import { userSummaryColumns, type UserSummaryRow } from '../../db/selections.js';
import type { Cursor } from '../../shared/pagination/cursor.js';

/**
 * A chat message joined with the public columns of its author (B-19: never `email` or `password_hash`). The author's
 * avatar is still a storage key here; the service builds the public URL (ADR-0010, B-05).
 */
export interface ChatMessageRow {
  id: number;
  body: string;
  createdAt: Date;
  author: UserSummaryRow;
}

export interface ListChatMessagesParams {
  /** Page size; the repository returns up to `limit + 1` rows so the service can tell whether a next page exists. */
  limit: number;
  /** Keyset position of the last row of the previous page (ADR-0014). */
  after?: Cursor;
}

export interface NewChatMessage {
  authorId: number;
  /** Already validated and trimmed (`SendChatMessage`); the table's CHECK rejects anything else. */
  body: string;
}

/** The service depends on this interface, so its unit tests can pass an in-memory fake. */
export interface ChatRepository {
  /** Newest first: `ORDER BY created_at DESC, id DESC` in SQL (B-72), `limit + 1` rows (B-73). */
  listMessages(params: ListChatMessagesParams): Promise<ChatMessageRow[]>;
  /** Inserts the message and returns the persisted row with its author in **one** statement (B-47, B-75). */
  insertMessage(message: NewChatMessage): Promise<ChatMessageRow>;
}

/** SQL of the chat lives only here (express-feature-module). */
export function createChatRepository(db: Database): ChatRepository {
  return {
    async listMessages({ limit, after }) {
      return (
        db
          .select({
            id: chatMessages.id,
            body: chatMessages.body,
            createdAt: chatMessages.createdAt,
            author: userSummaryColumns,
          })
          .from(chatMessages)
          .innerJoin(users, eq(users.id, chatMessages.authorId))
          // DATA-MODEL "Chat page": served by `chat_messages_created_idx` without a sort (ADR-0014).
          .where(keysetAfter({ createdAt: chatMessages.createdAt, id: chatMessages.id }, after))
          .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
          .limit(limit + 1)
      );
    },

    async insertMessage({ authorId, body }) {
      // `WITH inserted AS (INSERT … RETURNING …) SELECT … FROM inserted JOIN users`: id and created_at come from the
      // database (B-47), and the author is joined in the same round trip instead of a second lookup (B-75).
      const inserted = db.$with('inserted').as(
        db.insert(chatMessages).values({ authorId, body }).returning({
          id: chatMessages.id,
          authorId: chatMessages.authorId,
          body: chatMessages.body,
          createdAt: chatMessages.createdAt,
        }),
      );
      const [row] = await db
        .with(inserted)
        .select({
          id: inserted.id,
          body: inserted.body,
          createdAt: inserted.createdAt,
          author: userSummaryColumns,
        })
        .from(inserted)
        .innerJoin(users, eq(users.id, inserted.authorId));
      // The foreign key guarantees the author row, so an empty result is a broken invariant, not a client error.
      if (!row) throw new Error('Inserting a chat message returned no row');
      return row;
    },
  };
}
