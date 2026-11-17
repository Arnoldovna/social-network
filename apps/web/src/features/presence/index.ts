/*
 * Public API of the presence feature (BUILD-ORDER "Web feature exports fixed in Phase 1c"). Other code imports the
 * feature only through this file (ESLint boundaries).
 */

/** `/online`: everyone else who is online right now, kept current over the socket (F-86–F-89). */
export { OnlinePage } from './pages/OnlinePage';
