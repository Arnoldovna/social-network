import type { RequestHandler } from 'express';

import { validate } from '../../shared/http/validate.js';
import { ListChatMessagesQuery } from './chat.schema.js';
import type { ChatService } from './chat.service.js';

export interface ChatController {
  /** `GET /api/chat/messages` -> 200 `ChatPage`. */
  listMessages: RequestHandler;
}

/**
 * HTTP <-> service translation only: no SQL, no rules. Sending is the `chat:send` socket event (chat.socket.ts,
 * ADR-0005), so the chat has no HTTP mutation and therefore no CSRF-protected route of its own.
 */
export function createChatController(service: ChatService): ChatController {
  return {
    listMessages: validate({ query: ListChatMessagesQuery }, async ({ query }, _req, res) => {
      res.json(await service.listMessages(query));
    }),
  };
}
