import { useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link, useLocation } from 'react-router';

import { AvatarButton } from '../../features/avatars';
import { LogoutButton } from '../../features/auth';
import { HeaderSearch } from '../../features/search';
import { Button } from '../../shared/ui/Button';
import { MainNav } from './MainNav';
import './SiteHeader.css';

/**
 * The app header (F-92, ADR-0015): wordmark (link to `/`), the search, the main navigation, the avatar button and
 * "log out". The feature parts come from their `index.ts` (search, avatars, auth here; friends inside `MainNav`).
 *
 * One DOM, two layouts, switched by CSS only (SiteHeader.css):
 * - from 640 px, two rows: wordmark, avatar button and search in the first; the navigation and, at its end, "log out"
 *   in the second;
 * - below 640 px, wordmark, avatar button and a "menu" disclosure button (`aria-expanded`, `aria-controls`, F-94,
 *   B-109) that shows the search, the navigation and, last, "log out" in a panel below.
 * The DOM order is the visual order in both layouts, so the focus order follows what is seen (WCAG 2.4.3), and the
 * panel comes right after its button.
 */
export function SiteHeader() {
  const panelId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  // The menu belongs to the location it was opened on: any navigation (a link in the panel, back/forward, a search
  // result) closes it without an effect, because every navigation gets a new `location.key`.
  const [menuOpenedAt, setMenuOpenedAt] = useState<string | null>(null);
  const menuOpen = menuOpenedAt === location.key;

  const toggleMenu = () => {
    setMenuOpenedAt(menuOpen ? null : location.key);
  };

  const closeMenuOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    // A control inside the panel that uses Escape itself (the search combobox closing its listbox) prevents the
    // default, so one Escape never does both. An open modal dialog in the header (the avatar upload dialog) keeps its
    // Escape to itself (the shared `Dialog` stops its propagation), so it never reaches this handler.
    if (!menuOpen || event.key !== 'Escape' || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    setMenuOpenedAt(null);
    menuButtonRef.current?.focus();
  };

  return (
    <header className="site-header" onKeyDown={closeMenuOnEscape}>
      <Link className="site-header__brand" to="/">
        let's chat
      </Link>
      <div className="site-header__avatar">
        <AvatarButton variant="header" />
      </div>
      <div className="site-header__menu">
        <Button
          ref={menuButtonRef}
          className="site-header__menu-button"
          aria-expanded={menuOpen}
          aria-controls={panelId}
          onClick={toggleMenu}
        >
          menu
        </Button>
      </div>
      <div id={panelId} className={menuOpen ? 'site-header__panel site-header__panel--open' : 'site-header__panel'}>
        <div className="site-header__search">
          <HeaderSearch />
        </div>
        <div className="site-header__nav-row">
          <div className="site-header__nav">
            <MainNav />
          </div>
          <div className="site-header__logout">
            <LogoutButton />
          </div>
        </div>
      </div>
    </header>
  );
}
