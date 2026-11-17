import type { FriendshipState } from '@app/shared';
import { createElement, Fragment } from 'react';

/*
 * Public API of the friends feature, fixed in Phase 1c (BUILD-ORDER "Web feature exports"). These are stubs so the
 * router, the header and the profile pages can import it from the start; the Phase 3 friends unit replaces this body
 * with re-exports of its page and components and keeps the names and prop types.
 */

/** `/friends`: friends, incoming and outgoing requests (F-54). */
export function FriendsPage() {
  return createElement(
    Fragment,
    null,
    createElement('title', null, "Friends · Let's chat!"),
    createElement('h1', null, 'Friends'),
  );
}

/** The friendship action on another user's profile (F-45). */
export function FriendButton(_props: { userId: number; userName: string; state: FriendshipState }) {
  return null;
}

/** The incoming-request count beside the "friends" navigation link (F-52). */
export function FriendsNavBadge() {
  return null;
}
