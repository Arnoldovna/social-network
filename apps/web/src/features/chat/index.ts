/*
 * Public API of the chat feature, fixed in Phase 1c (BUILD-ORDER "Web feature exports"). Other code imports the chat
 * only through this file (ESLint boundaries).
 */

/** `/chat`: the global chat room (F-76). */
export { ChatPage } from './pages/ChatPage';
