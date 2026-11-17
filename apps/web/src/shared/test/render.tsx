import type { Store } from '@reduxjs/toolkit';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { Provider } from 'react-redux';
import { createMemoryRouter } from 'react-router';
import type { RouteObject } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import { createTestStore } from '../api/__tests__/fixtures';

/*
 * Render helpers for component tests (OVERVIEW §14): the UI inside a Redux `<Provider>` and a memory data router, as
 * in the app, so RTK Query hooks, `Link`/`NavLink`, `useParams` and loaders work. They live in `shared/`, which may
 * not import `app/`, so the default store is the shared test store (the API and realtime slices of `app/store.ts`);
 * app tests pass the real `createAppStore()` instead. Network goes through MSW (`shared/test/msw.ts`), set up per test.
 */

export interface RouterRenderOptions<S extends Store> {
  /** Defaults to a fresh `createTestStore().store`. */
  store?: S;
  /** The history to start with; the last entry is the current URL. Default `['/']`. */
  initialEntries?: string[];
}

export interface ProviderRenderOptions<S extends Store> extends RouterRenderOptions<S> {
  /** The route pattern `ui` is rendered at, so `useParams` works: `{ path: '/users/:id', initialEntries: ['/users/7'] }`. */
  path?: string;
  /** More routes beside it, e.g. a stand-in page that proves a navigation happened. */
  routes?: RouteObject[];
}

export type RouterRenderResult<S extends Store> = RenderResult & {
  store: S;
  router: ReturnType<typeof createMemoryRouter>;
  /** `userEvent.setup()`, created before rendering as Testing Library recommends. */
  user: ReturnType<typeof userEvent.setup>;
};

/** Renders a route table (with loaders, layouts and error elements) on a memory router. */
export function renderRoutes<S extends Store = ReturnType<typeof createTestStore>['store']>(
  routes: RouteObject[],
  { store, initialEntries = ['/'] }: RouterRenderOptions<S> = {},
): RouterRenderResult<S> {
  // The default store's type is the default type argument; a caller that names another `S` also passes its store.
  const activeStore = (store ?? createTestStore().store) as S;
  const router = createMemoryRouter(routes, { initialEntries });
  const user = userEvent.setup();
  const result = render(
    <Provider store={activeStore}>
      <RouterProvider router={router} />
    </Provider>,
  );
  return { ...result, store: activeStore, router, user };
}

/** Renders one element inside the store and a memory router, at `path` (default: every URL). */
export function renderWithProviders<S extends Store = ReturnType<typeof createTestStore>['store']>(
  ui: ReactElement,
  { path = '*', routes = [], ...options }: ProviderRenderOptions<S> = {},
): RouterRenderResult<S> {
  return renderRoutes<S>([{ path, element: ui }, ...routes], options);
}
