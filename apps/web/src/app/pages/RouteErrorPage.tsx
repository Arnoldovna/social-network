import { isRouteErrorResponse, Link, useRevalidator, useRouteError } from 'react-router';

import { isApiError } from '../../shared/api/problem';
import type { ApiError } from '../../shared/api/problem';
import { ErrorState } from '../../shared/ui/ErrorState';
import { NotFoundPage } from './NotFoundPage';
import './RouteErrorPage.css';

const FALLBACK_MESSAGE = 'Something went wrong on our side. Please try again in a moment.';

/** The `ApiError` behind a route error: thrown as is, or as the `cause` of the `Error` the loaders throw. */
function apiErrorOf(error: unknown): ApiError | null {
  if (isApiError(error)) {
    return error;
  }
  if (error instanceof Error && isApiError(error.cause)) {
    return error.cause;
  }
  return null;
}

/**
 * The `errorElement` of the routes (ADR-0013, F-105): a loader that could not reach the API (`GET /api/me` failed with
 * something other than 401) or a page that crashed while rendering. It renders inside RootLayout (skip link,
 * "Reconnecting…" banner), and only as the root's own `errorElement` when RootLayout itself crashed. It shows one
 * plain sentence, never the raw error or a stack trace, offers "try again" (re-runs the loaders, F-105) and a link to
 * the start page. A 404 route response renders the not-found page instead.
 */
export function RouteErrorPage() {
  const error = useRouteError();
  const revalidator = useRevalidator();

  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundPage />;
  }

  const message = apiErrorOf(error)?.message ?? FALLBACK_MESSAGE;
  const retrying = revalidator.state === 'loading';

  return (
    <div className="route-error-page">
      <title>Something went wrong · Let's chat!</title>
      <header className="route-error-page__header">
        <Link className="route-error-page__wordmark" to="/" reloadDocument>
          let's chat
        </Link>
      </header>
      <main id="main" className="route-error-page__main">
        <h1 className="route-error-page__title">Something went wrong</h1>
        <ErrorState
          title="This page could not be loaded."
          message={message}
          onRetry={() => {
            void revalidator.revalidate();
          }}
          retrying={retrying}
        />
        <Link className="route-error-page__link" to="/" reloadDocument>
          <span aria-hidden="true">← </span>back to the start page
        </Link>
      </main>
    </div>
  );
}
