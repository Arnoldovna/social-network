import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

import { FriendsNavBadge } from '../../features/friends';
import './MainNav.css';

interface MainNavItemProps {
  to: string;
  /** Lowercase label (maw-design-system §10). */
  label: string;
  /** Only `/` needs it: without `end`, "profile" would be current on every page. */
  end?: boolean;
  /** Shown after the link inside the same item, e.g. the friend-request count (F-52). */
  children?: ReactNode;
}

function MainNavItem({ to, label, end = false, children }: MainNavItemProps) {
  return (
    <li className="main-nav__item">
      {/*
       * The function form keeps React Router from adding its unstyled `active` class; the current page is marked by
       * `aria-current="page"` (NavLink's default), which MainNav.css styles (F-93).
       */}
      <NavLink className={() => 'main-nav__link'} to={to} end={end}>
        {label}
      </NavLink>
      {children}
    </li>
  );
}

/**
 * The app's main navigation, "profile / friends / online / chat" (F-92). `NavLink` navigates inside the one data
 * router, so a click never reloads the page or reconnects the socket (F-03, B-79), and it sets `aria-current="page"` on
 * the current page (F-93). The header places it in its second row from 640 px and in the "menu" panel below (ADR-0015).
 */
export function MainNav() {
  return (
    <nav className="main-nav" aria-label="Main">
      <ul className="main-nav__list">
        <MainNavItem to="/" label="profile" end />
        <MainNavItem to="/friends" label="friends">
          <FriendsNavBadge />
        </MainNavItem>
        <MainNavItem to="/online" label="online" />
        <MainNavItem to="/chat" label="chat" />
      </ul>
    </nav>
  );
}
