/*
 * Public API of the avatars feature, fixed in Phase 1c (BUILD-ORDER "Web feature exports"). A stub so the header and
 * the profile pages can import it from the start; the Phase 3 avatars unit replaces this body with a re-export of its
 * component and keeps the name and the prop type.
 */

/** The user's avatar as a "Change profile picture" button that opens the upload dialog (F-33, B-103). */
export function AvatarButton(_props: { variant: 'header' | 'profile' }) {
  return null;
}
