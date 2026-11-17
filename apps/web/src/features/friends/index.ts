/*
 * Public API of the friends feature (BUILD-ORDER "Web feature exports fixed in Phase 1c"). Other features and the app
 * shell import only from here: the router renders `FriendsPage`, the header's `MainNav` renders `FriendsNavBadge`,
 * and the profile page renders `FriendButton(props: { userId: number; userName: string; state: FriendshipState })`.
 */

/** `/friends`: friend requests, friends and sent requests (F-54–F-57). */
export { FriendsPage } from './pages/FriendsPage';
/** The friendship action on another user's profile (F-45–F-53). */
export { FriendButton } from './components/FriendButton';
/** The incoming-request count beside the "friends" navigation link (F-52). */
export { FriendsNavBadge } from './components/FriendsNavBadge';
