import { Outlet } from 'react-router';

import { SiteHeader } from '../header/SiteHeader';
import './AppLayout.css';

/**
 * Layout of the signed-in area (`/`, `/users/:id`, `/friends`, `/online`, `/chat`; ADR-0013): the page column with the
 * header (banner landmark with the main navigation) and the `<main id="main">` landmark the skip link targets (its
 * default target, F-103). Pages render their own `<title>` and one `<h1>` into the outlet. The header lives here,
 * inside the router, so navigating never remounts it and never reconnects the socket (F-03).
 */
export function AppLayout() {
  return (
    <div className="app-layout">
      <SiteHeader />
      <main id="main" className="app-layout__main">
        <Outlet />
      </main>
    </div>
  );
}
