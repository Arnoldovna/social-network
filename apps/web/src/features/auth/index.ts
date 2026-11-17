import { createElement, Fragment } from 'react';

/*
 * Public API of the auth feature, fixed in Phase 1c (BUILD-ORDER "Web feature exports"). These are stubs so the router
 * and the header can import every feature from the start; the Phase 3 auth unit replaces this body with re-exports of
 * its pages and components and keeps the names and prop types.
 */

function stubPage(title: string) {
  return createElement(
    Fragment,
    null,
    createElement('title', null, `${title} · Let's chat!`),
    createElement('h1', null, title),
  );
}

/** `/welcome`: the registration form (F-06). */
export function RegisterPage() {
  return stubPage('Sign up');
}

/** `/welcome/login`: the login form; `?reason=expired` shows the session-expired message (F-14, F-22). */
export function LoginPage() {
  return stubPage('Log in');
}

/** `/welcome/about`: about the project (F-97). */
export function AboutPage() {
  return stubPage('About');
}

/** The rose brand panel beside the welcome forms (F-95). */
export function BrandPanel() {
  return null;
}

/** "log out" in the header (F-20). */
export function LogoutButton() {
  return null;
}
