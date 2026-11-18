import { Link, useLoaderData } from 'react-router';

import { WELCOME_ABOUT_PATH } from '../../shared/lib/paths';
import { SiteFooter } from '../footer/SiteFooter';
import { AppLayout } from '../layouts/AppLayout';
import type { NotFoundData } from '../loaders';
import './NotFoundPage.css';

/**
 * "Page not found" itself (F-04): title, one sentence and a link back to the start page. A left-aligned empty-state
 * composition (maw-design-system §6 "Empty state"): no illustration, no centring.
 */
function NotFoundContent() {
  return (
    <div className="not-found">
      <title>Page not found · Let's chat!</title>
      <h1 className="not-found__title">Page not found</h1>
      <p className="not-found__text">
        There is nothing at this address. Check it for typos, or go back to the start page.
      </p>
      <Link className="not-found__link" to="/">
        <span aria-hidden="true">←</span>
        back to the start page
      </Link>
    </div>
  );
}

/**
 * The visitor's not-found page: outside both layouts, so it brings its own banner with the wordmark, its own
 * `<main id="main">` for the skip link (F-103) and the visitor footer. `/` sends a visitor on to `/welcome`.
 */
export function NotFoundPage() {
  return (
    <div className="not-found-page">
      <header className="not-found-page__header">
        <Link className="not-found-page__wordmark" to="/">
          let's chat
        </Link>
      </header>
      <main id="main" className="not-found-page__main">
        <NotFoundContent />
      </main>
      <SiteFooter aboutPath={WELCOME_ABOUT_PATH} />
    </div>
  );
}

/**
 * Every path no route matches (`*`, ADR-0013, F-04). A signed-in user gets the page inside the app layout, with the
 * header and its navigation, so they are never left without a way around the site; a visitor gets the standalone
 * page. Unknown `/api/*` paths never get here: nginx sends them to the API, which answers with a 404 problem (B-57).
 */
export function NotFoundRoute() {
  const { signedIn } = useLoaderData<NotFoundData>();
  return signedIn ? (
    <AppLayout>
      <NotFoundContent />
    </AppLayout>
  ) : (
    <NotFoundPage />
  );
}
