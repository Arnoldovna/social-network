/*
 * Public API of the avatars feature (BUILD-ORDER "Web feature exports", fixed in Phase 1c). The header and the own
 * profile page import `AvatarButton` from here; everything else in this folder is internal.
 */

/** The user's avatar as a "Change profile picture" button that opens the upload dialog (F-33, B-103). */
export { AvatarButton } from './components/AvatarButton';
