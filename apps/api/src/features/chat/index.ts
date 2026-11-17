// Public API of the chat feature (BUILD-ORDER "Module signatures fixed in Phase 1b"). The composition root imports only
// from here; the exported names and types are frozen.
import type { RequestHandler, Router } from 'express';
import type { Logger } from 'pino';

import type { Database } from '../../db/client.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { SocketEventLimiter } from '../../shared/realtime/event-limiter.js';
import type { SessionGuard } from '../../shared/realtime/session-guard.js';
import type { SocketRegistrar } from '../../shared/realtime/types.js';
import { createChatController } from './chat.controller.js';
import { createChatRepository } from './chat.repository.js';
import { createChatRouter } from './chat.routes.js';
import { createChatService } from './chat.service.js';
import { createChatSocketRegistrar } from './chat.socket.js';

export interface ChatModuleDeps {
  db: Database;
  requireAuth: RequestHandler;
  avatarUrl: AvatarUrl;
  /** `chat:send` per user (`limits.chatSend`, F-84). */
  chatLimiter: SocketEventLimiter;
  /** Per-event session check of `chat:send`. */
  sessionGuard: SessionGuard;
  logger: Logger;
}

export interface ChatModule {
  /** Mounted at `/api`; declares `/chat/messages`. */
  router: Router;
  /** `chat:send`; broadcasts `chat:message` through the `io` it receives (no publisher). */
  registerSocket: SocketRegistrar;
}

/** Wiring only, no I/O: safe to call at app construction (BUILD-ORDER rule 7). */
export function createChatModule(deps: ChatModuleDeps): ChatModule {
  const service = createChatService({ repository: createChatRepository(deps.db), avatarUrl: deps.avatarUrl });
  return {
    router: createChatRouter({ controller: createChatController(service), requireAuth: deps.requireAuth }),
    registerSocket: createChatSocketRegistrar({
      service,
      chatLimiter: deps.chatLimiter,
      sessionGuard: deps.sessionGuard,
      logger: deps.logger,
    }),
  };
}
