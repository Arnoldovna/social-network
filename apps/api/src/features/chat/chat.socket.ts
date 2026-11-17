import type { Logger } from 'pino';

import { ok, onClientEvent } from '../../shared/realtime/ack.js';
import type { SocketEventLimiter } from '../../shared/realtime/event-limiter.js';
import { rooms } from '../../shared/realtime/rooms.js';
import type { SessionGuard } from '../../shared/realtime/session-guard.js';
import type { SocketRegistrar } from '../../shared/realtime/types.js';
import { SendChatMessage } from './chat.schema.js';
import type { ChatService } from './chat.service.js';

export interface ChatSocketDeps {
  service: ChatService;
  /** `chat:send` per user, 10 per 10 s in production (F-84). */
  chatLimiter: SocketEventLimiter;
  /** `chat:send` mutates, so the session is re-checked on every event (ADR-0005). */
  sessionGuard: SessionGuard;
  logger: Pick<Logger, 'debug' | 'error'>;
}

/**
 * `chat:send` (API.md §3, OVERVIEW §3 "Socket event (chat)"): session-alive guard -> `SendChatMessage.safeParse`
 * (F-78, F-112, B-48) -> per-user limiter (F-84) -> persist (B-47) -> `chat:message` to `rooms.chat` -> ack
 * `{ ok: true, message }`. Every failure is an ack with a code, never a thrown error (`onClientEvent`).
 *
 * The broadcast reaches every authenticated socket, the sender's own tabs included; clients de-duplicate by `id`
 * (F-79). Connecting emits nothing: history is `GET /api/chat/messages` per client (F-85, B-42).
 */
export function createChatSocketRegistrar({
  service,
  chatLimiter,
  sessionGuard,
  logger,
}: ChatSocketDeps): SocketRegistrar {
  return (socket, io) => {
    onClientEvent(socket, 'chat:send', {
      schema: SendChatMessage,
      sessionGuard,
      limiter: chatLimiter,
      logger,
      async handle(input, sender) {
        const message = await service.send(sender.data.user.id, input);
        io.to(rooms.chat).emit('chat:message', message);
        return ok({ message });
      },
    });
  };
}
