# ADR-0013: One data router with loader guards, real paths and a not-found page

- Status: accepted (revised after the architecture critique: loaders treat 401 as a visitor)
- Date: 2026-11-15
- Related: B-57, B-79, B-98, B-101, B-140, F-01–F-05, F-41, F-42, F-103

## Context

Legacy routing mixed `HashRouter` (welcome, nested about router) and `BrowserRouter` (app), decided by
`location.pathname` at start-up (B-140), rendered navigation outside the router so every click reloaded the page
(B-79), and served the SPA for every unknown path (B-57).

## Decision

- React Router 8.5.1 in data mode: `createBrowserRouter` + `RouterProvider`, defined in `app/router.tsx`:

```
/                      RootLayout (SkipLink, ConnectionBanner; errorElement: RouteErrorPage for a RootLayout crash)
└─ (pathless)          errorElement: RouteErrorPage (loader errors, page crashes; rendered inside RootLayout)
   ├─ /welcome         WelcomeLayout   loader: redirectIfAuthenticated → redirect('/') (F-02)
   │  ├─ index         RegisterPage    title "Sign up · Let's chat!"
   │  ├─ login         LoginPage       title "Log in · Let's chat!"  (?reason=expired shows the F-22 message)
   │  └─ about         AboutPage       title "About · Let's chat!"
   ├─ (pathless)       AppLayout       loader: requireUser → redirect('/welcome') on 401 (F-01)
   │  ├─ index         OwnProfilePage  title "<First Last> · Let's chat!"
   │  ├─ users/:id     UserProfilePage loader: id === me → redirect('/') (F-41)
   │  ├─ friends       FriendsPage
   │  ├─ online        OnlinePage
   │  └─ chat          ChatPage        title "Chat · Let's chat!"
   └─ *                NotFoundPage    "Page not found" + link to "/" (F-04)
```

- The error boundary sits on a pathless child of RootLayout (amended at Gate 1c), not on the root route itself: an
  `errorElement` replaces its route's element, so on the root it would drop the skip link (F-103) and the
  "Reconnecting…" banner (F-107) from the error page. The root keeps one only as the last resort for RootLayout.

- Loaders use the store: `await store.dispatch(meApi.endpoints.getMe.initiate()).unwrap()`; the result stays cached,
  so pages read it with `useCurrentUser()`. A 401 from `getMe` means "visitor" and is handled **silently**:
  `requireUser` redirects to `/welcome` (no `reason`), `redirectIfAuthenticated` renders the welcome pages. Neither
  loader dispatches `sessionExpired`; only the base query does, and only for a client that was authenticated
  (ADR-0012). Other errors from `getMe` propagate to `RouteErrorPage`.
- `router.tsx` imports the store for the loaders; the store does not import the router. Navigation needed by the
  session listener is injected from `main.tsx` (`startSessionListener(store, router.navigate)`).
- Navigation uses `NavLink` (sets `aria-current="page"`, F-93); the header is inside `AppLayout`, so navigation
  never reloads and never reconnects the socket (F-03).
- Document titles with React 19's `<title>` element rendered by each page (F-05).
- `UserProfilePage` renders the friend button and wall only after the profile loaded successfully; 400/404 render
  "This user does not exist." (F-42, B-98).
- Focus management: on route change, focus moves to the page `<h1>` (one per page, F-103); so it does after a
  revalidation ("try again" on `RouteErrorPage`) that removed the focused element.
- nginx: `try_files $uri $uri/ /index.html` for navigations, `/api/` and `/socket.io/` proxied, so unknown API paths
  reach Express' 404 problem handler.

## Alternatives

- **Declarative `<Routes>` with guard components**: guards would render before redirecting (flash of protected
  content); loaders redirect before render.
- **Framework mode / SSR (React Router as a framework)**: not needed for an authenticated SPA and adds a server.

## Consequences

- Route modules import page components from feature `index.ts` files; the router file is created in the scaffold
  phase with stub pages so frontend features can be built in parallel.
- Loader tests run with a test store and MSW, including: a visitor stays on `/welcome` and `/welcome/about`
  without `reason=expired`; a logged-in user whose next call returns 401 lands on `/welcome/login?reason=expired`
  and sees the message once.
