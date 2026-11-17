/*
 * Public API of the wall feature (BUILD-ORDER "Web feature exports", fixed in Phase 1c). Other features import only
 * from here: the profile pages render
 * `<Wall ownerId={…} ownerFirstName={…} canView={relationship.canViewWall} canPost={relationship.canPostOnWall} />`.
 */

/** A profile's wall: posts, composer and "load older posts" (F-65–F-75). */
export { Wall } from './components/Wall';
