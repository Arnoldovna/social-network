/*
 * Public API of the wall feature, fixed in Phase 1c (BUILD-ORDER "Web feature exports"). A stub so the profile pages
 * can import it from the start; the Phase 3 wall unit replaces this body with a re-export of its component and keeps
 * the name and the prop type.
 */

/** A profile's wall: posts, composer and "load older" (F-65, F-69). */
export function Wall(_props: { ownerId: number; ownerFirstName: string; canView: boolean; canPost: boolean }) {
  return null;
}
