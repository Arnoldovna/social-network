import { Link, Outlet } from 'react-router';

import { BrandPanel } from '../../features/auth';
import { WELCOME_ABOUT_PATH } from '../../shared/lib/paths';
import { SiteFooter } from '../footer/SiteFooter';
import './WelcomeLayout.css';

/**
 * Layout of the visitor area (`/welcome`, `/welcome/login`, `/welcome/about`; ADR-0013): a banner with the wordmark
 * and the auth feature's brand panel, and the `<main id="main">` landmark (the skip link's default target, F-103) with
 * the form or the about text. One column on small screens, two columns from 1024 px: brand left, content right
 * (F-95). Links between sign up, log in and about live in the pages themselves (F-96); the footer spans both columns
 * (ADR-0015).
 */
export function WelcomeLayout() {
  return (
    <div className="welcome-layout">
      <header className="welcome-layout__header">
        <Link className="welcome-layout__wordmark" to="/welcome">
          let's chat
        </Link>
        <BrandPanel />
      </header>
      <main id="main" className="welcome-layout__main">
        <Outlet />
      </main>
      <div className="welcome-layout__footer">
        <SiteFooter aboutPath={WELCOME_ABOUT_PATH} />
      </div>
    </div>
  );
}
