// Public API of the chat feature (BUILD-ORDER "Module signatures fixed in Phase 1b"). The composition root imports only
// from here. Phase 1b stub: the signature is final, the Phase 2 chat unit fills the body and keeps every exported name
// and type.
import { Router, type RequestHandler } from 'express';
import type { Logger } from 'pino';

import type { Database } from '../../db/client.js';
import type { AvatarUrl } from '../../shared/media/media-url.js';
import type { SocketEventLimiter } from '../../shared/realtime/event-limiter.js';
import type { SessionGuard } from '../../shared/realtime/session-guard.js';
import type { SocketRegistrar } from '../../shared/realtime/types.js';

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

export function createChatModule(_deps: ChatModuleDeps): ChatModule {
  return { router: Router(), registerSocket: () => undefined };
}
