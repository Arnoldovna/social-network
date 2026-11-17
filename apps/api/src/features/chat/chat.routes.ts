import { Router, type RequestHandler } from 'express';

import type { ChatController } from './chat.controller.js';

export interface ChatRouteDeps {
  controller: ChatController;
  requireAuth: RequestHandler;
}

/** Mounted at `/api` with full sub-paths; `requireAuth` per route, never router-wide (BUILD-ORDER 1b). */
export function createChatRouter({ controller, requireAuth }: ChatRouteDeps): Router {
  const router = Router();
  router.get('/chat/messages', requireAuth, controller.listMessages);
  return router;
}
