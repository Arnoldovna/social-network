// Request schemas and response DTOs of the chat feature. They are the shared API contract (API.md §1, ADR-0003):
// defined once in `packages/shared/src/chat.ts` and re-exported here, so the API, the web app and the tests validate
// against the very same schemas.
import { PageQuery } from '@app/shared';

export { CHAT_MAX, ChatMessage, ChatPage, SendChatMessage } from '@app/shared';

/** `GET /api/chat/messages`: `limit` 1–50 (default 20) and the opaque cursor of the previous page (F-76, F-82). */
export const ListChatMessagesQuery = PageQuery;
export type ListChatMessagesQuery = PageQuery;
