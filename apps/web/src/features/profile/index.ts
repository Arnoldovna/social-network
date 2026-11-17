/*
 * Public API of the profile feature (BUILD-ORDER "Web feature exports fixed in Phase 1c"). Only the two pages leave the
 * feature; the router imports them from here.
 */

/** `/`: the signed-in user's profile, bio and wall (F-24). */
export { OwnProfilePage } from './pages/OwnProfilePage';

/** `/users/:id`: another user's profile, friend button and wall (F-40). */
export { UserProfilePage } from './pages/UserProfilePage';
