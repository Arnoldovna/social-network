import { Link } from 'react-router';

import './NotFoundPage.css';

/**
 * Every path no route matches (`*`, ADR-0013, F-04): "Page not found" with a link back to the start page, for visitors
 * and users alike (`/` sends a visitor on to `/welcome`). It sits outside both layouts, so it brings its own banner
 * with the wordmark and its own `<main id="main">` for the skip link (F-103). Unknown `/api/*` paths never get here:
 * nginx sends them to the API, which answers with a 404 problem (B-57).
 */
export function NotFoundPage() {
  return (
    <div className="not-found-page">
      <title>Page not found · Let's chat!</title>
      <header className="not-found-page__header">
        <Link className="not-found-page__wordmark" to="/">
          let's chat
        </Link>
      </header>
      <main id="main" className="not-found-page__main">
        <h1 className="not-found-page__title">Page not found</h1>
        <p className="not-found-page__text">
          There is nothing at this address. Check it for typos, or go back to the start page.
        </p>
        <Link className="not-found-page__link" to="/">
          <span aria-hidden="true">← </span>back to the start page
        </Link>
      </main>
    </div>
  );
}
