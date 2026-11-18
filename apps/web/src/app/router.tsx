import { useEffect, useRef } from 'react';
import { createBrowserRouter, Outlet, ScrollRestoration, useLocation, useRevalidator } from 'react-router';
import type { RouteObject } from 'react-router';

import { AboutPage, LoginPage, RegisterPage } from '../features/auth';
import { ChatPage } from '../features/chat';
import { FriendsPage } from '../features/friends';
import { OnlinePage } from '../features/presence';
import { OwnProfilePage, UserProfilePage } from '../features/profile';
import { LoadingState } from '../shared/ui/LoadingState';
import { SkipLink } from '../shared/ui/SkipLink';
import { ConnectionBanner } from './ConnectionBanner';
import { AppLayout } from './layouts/AppLayout';
import { WelcomeLayout } from './layouts/WelcomeLayout';
import { createLoaders } from './loaders';
import { NotFoundRoute } from './pages/NotFoundPage';
import { RouteErrorPage } from './pages/RouteErrorPage';
import type { AppStore } from './store';

/** Focuses the current page's `<h1>`, or `<main>` while the page has no heading yet (still loading). */
function focusPageHeading(): void {
  const main = document.getElementById('main');
  const target = main?.querySelector('h1') ?? main;
  if (target === null) {
    return;
  }
  if (!target.hasAttribute('tabindex')) {
    // Not a Tab stop, only a focus target.
    target.setAttribute('tabindex', '-1');
  }
  target.focus();
}

/**
 * Moves focus to the new page's `<h1>` after every client-side navigation (ADR-0013, F-103), so keyboard and screen
 * reader users start at the new content instead of on the link they used. The first page load keeps the browser's
 * default (the skip link is the first Tab stop). Comparing `location.key` (not a "first render" flag) keeps it correct
 * under StrictMode's double effects.
 *
 * A revalidation ("try again" on `RouteErrorPage`) replaces the page without a new location. When it removed the
 * element that had focus (the button itself), focus would fall back to the document, so it goes to the heading too.
 */
function useFocusOnNavigation(): void {
  const { key } = useLocation();
  const { state: revalidation } = useRevalidator();
  const shownKey = useRef(key);
  const wasRevalidating = useRef(false);

  useEffect(() => {
    if (shownKey.current === key) {
      return;
    }
    shownKey.current = key;
    focusPageHeading();
  }, [key]);

  useEffect(() => {
    if (revalidation === 'loading') {
      wasRevalidating.current = true;
      return;
    }
    if (!wasRevalidating.current) {
      return;
    }
    wasRevalidating.current = false;
    if (document.activeElement === null || document.activeElement === document.body) {
      focusPageHeading();
    }
  }, [revalidation]);
}

/** Wraps every route: skip link first (F-103), the "Reconnecting…" banner (F-107), the page, scroll restoration. */
function RootLayout() {
  useFocusOnNavigation();
  return (
    <>
      <SkipLink />
      <ConnectionBanner />
      <Outlet />
      <ScrollRestoration />
    </>
  );
}

/** Shown while the first navigation's loaders (`GET /api/me`) run, so the page is never blank (F-105). */
function InitialLoading() {
  return <LoadingState />;
}

/**
 * The route table (ADR-0013). Pages come from the feature `index.ts` files only (ESLint boundaries); the guards are
 * `loaders.ts` bound to `store`. A factory, so tests build the same table on a memory router with their own store.
 *
 * The error boundary for loaders and pages is a pathless route *inside* RootLayout, so `RouteErrorPage` keeps the skip
 * link (F-103), the "Reconnecting…" banner (F-107) and the focus handling. The root's own `errorElement` only catches
 * a crash of RootLayout itself.
 *
 * ```
 * /                    RootLayout                  errorElement: RouteErrorPage (RootLayout crashed)
 * └─ (pathless)        Outlet                      errorElement: RouteErrorPage (loader failed, page crashed)
 *    ├─ /welcome       WelcomeLayout               redirectIfAuthenticated → / (F-02)
 *    │  ├─ index       RegisterPage
 *    │  ├─ login       LoginPage                   ?reason=expired → session-expired message (F-22)
 *    │  └─ about       AboutPage
 *    ├─ (pathless)     AppLayout                   requireUser → /welcome (F-01)
 *    │  ├─ index       OwnProfilePage
 *    │  ├─ users/:id   UserProfilePage             redirectIfOwnProfile → / (F-41)
 *    │  ├─ friends     FriendsPage
 *    │  ├─ online      OnlinePage
 *    │  ├─ chat        ChatPage
 *    │  └─ about       AboutPage (member variant)  the footer's "about" for members (ADR-0015)
 *    └─ *              NotFoundRoute               (F-04) inside AppLayout for a member, standalone for a visitor
 * ```
 */
export function createRoutes(store: AppStore): RouteObject[] {
  const loaders = createLoaders(store);

  return [
    {
      path: '/',
      element: <RootLayout />,
      errorElement: <RouteErrorPage />,
      HydrateFallback: InitialLoading,
      children: [
        {
          errorElement: <RouteErrorPage />,
          children: [
            {
              path: 'welcome',
              element: <WelcomeLayout />,
              loader: loaders.redirectIfAuthenticated,
              children: [
                { index: true, element: <RegisterPage /> },
                { path: 'login', element: <LoginPage /> },
                { path: 'about', element: <AboutPage /> },
              ],
            },
            {
              element: <AppLayout />,
              loader: loaders.requireUser,
              children: [
                { index: true, element: <OwnProfilePage /> },
                { path: 'users/:id', element: <UserProfilePage />, loader: loaders.redirectIfOwnProfile },
                { path: 'friends', element: <FriendsPage /> },
                { path: 'online', element: <OnlinePage /> },
                { path: 'chat', element: <ChatPage /> },
                { path: 'about', element: <AboutPage audience="member" /> },
              ],
            },
            { path: '*', element: <NotFoundRoute />, loader: loaders.notFound },
          ],
        },
      ],
    },
  ];
}

/** The tab's one data router with real paths (F-03, B-140). `main.tsx` creates it once. */
export function createAppRouter(store: AppStore) {
  return createBrowserRouter(createRoutes(store));
}
