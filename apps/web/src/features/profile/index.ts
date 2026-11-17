import { createElement, Fragment } from 'react';

/*
 * Public API of the profile feature, fixed in Phase 1c (BUILD-ORDER "Web feature exports"). These are stubs so the
 * router can import every page from the start; the Phase 3 profile unit replaces this body with re-exports of its pages
 * and keeps the names.
 */

function stubPage(title: string) {
  return createElement(
    Fragment,
    null,
    createElement('title', null, `${title} · Let's chat!`),
    createElement('h1', null, title),
  );
}

/** `/`: the signed-in user's profile, bio and wall (F-24). */
export function OwnProfilePage() {
  return stubPage('Profile');
}

/** `/users/:id`: another user's profile, friend button and wall (F-40). */
export function UserProfilePage() {
  return stubPage('Profile');
}
