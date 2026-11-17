import { z } from 'zod';

import { pageOf } from './pagination.js';
import { UserSummary } from './user.js';

/** Upper bound of a chat message after trimming (F-78). */
export const CHAT_MAX = 1000;

/** A message as `GET /api/chat/messages`, the `chat:send` ack and `chat:message` deliver it. */
export const ChatMessage = z.strictObject({
  id: z.number().int().positive(),
  author: UserSummary,
  body: z.string(),
  createdAt: z.iso.datetime(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** `GET /api/chat/messages`, newest first; the client reverses each page for display (F-76). */
export const ChatPage = pageOf(ChatMessage);
export type ChatPage = z.infer<typeof ChatPage>;

/** Payload of the `chat:send` socket event: 1–1,000 characters after trimming (F-78, F-112). */
export const SendChatMessage = z.object({ body: z.string().trim().min(1).max(CHAT_MAX) });
export type SendChatMessage = z.infer<typeof SendChatMessage>;
