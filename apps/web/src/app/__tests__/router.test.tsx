import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MIRA } from '../../shared/api/__tests__/fixtures';
import { messageFor } from '../../shared/api/problem';
import { apiUrl, HttpResponse, http, problemResponse, server } from '../../shared/test/msw';
import { renderRoutes } from '../../shared/test/render';
import { createRoutes } from '../router';
import { createAppStore } from '../store';

vi.mock('../../features/auth', async () => (await import('./fakes')).authFeature);
vi.mock('../../features/profile', async () => (await import('./fakes')).profileFeature);
vi.mock('../../features/avatars', async () => (await import('./fakes')).avatarsFeature);
vi.mock('../../features/friends', async () => (await import('./fakes')).friendsFeature);
vi.mock('../../features/search', async () => (await import('./fakes')).searchFeature);
vi.mock('../../features/chat', async () => (await import('./fakes')).chatFeature);
vi.mock('../../features/presence', async () => (await import('./fakes')).presenceFeature);

function renderApp(path: string) {
  const store = createAppStore();
  return renderRoutes(createRoutes(store), { store, initialEntries: [path] });
}

function signedIn() {
  server.use(http.get(apiUrl('/me'), () => HttpResponse.json({ user: MIRA })));
}

describe('NotFoundRoute (F-04)', () => {
  it.each(['/no-such-page', '/welcome/no-such-page', '/users/7/posts'])(
    'shows a visitor "Page not found" in its own shell with a link to the start page at %s',
    async (path) => {
      server.use(http.get(apiUrl('/me'), () => problemResponse(401, 'unauthorized')));
      renderApp(path);

      expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
      const main = screen.getByRole('main');
      expect(within(main).getByRole('link', { name: 'back to the start page' })).toHaveAttribute('href', '/');
      expect(screen.getByRole('banner')).toBeInTheDocument();
      // The visitor shell has the wordmark only, no site navigation.
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
      await waitFor(() => {
        expect(document.title).toBe("Page not found · Let's chat!");
      });
    },
  );

  it('shows a signed-in user "Page not found" inside the app layout, with the site navigation and footer', async () => {
    signedIn();
    renderApp('/no-such-page');

    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('link', { name: 'back to the start page' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'log out' })).toBeInTheDocument();
    expect(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'about' })).toHaveAttribute(
      'href',
      '/about',
    );
  });

  it('still says "Page not found", in the visitor shell, when GET /api/me fails', async () => {
    server.use(http.get(apiUrl('/me'), () => problemResponse(500, 'internal')));
    renderApp('/no-such-page');

    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});

describe('RouteErrorPage (F-105)', () => {
  it('shows a plain sentence and "try again" when GET /api/me fails, then recovers', async () => {
    let failing = true;
    server.use(
      http.get(apiUrl('/me'), () =>
        failing
          ? problemResponse(500, 'internal', { detail: 'Connection terminated' })
          : HttpResponse.json({ user: MIRA }),
      ),
    );
    const { user } = renderApp('/');

    expect(await screen.findByRole('heading', { level: 1, name: 'Something went wrong' })).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(messageFor('internal'));
    // The server's detail is never shown verbatim.
    expect(screen.queryByText(/Connection terminated/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'back to the start page' })).toHaveAttribute('href', '/');

    failing = false;
    await user.click(screen.getByRole('button', { name: 'try again' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
  });

  it('keeps the skip link and the "Reconnecting…" region of RootLayout (F-103, F-107)', async () => {
    server.use(http.get(apiUrl('/me'), () => problemResponse(502, 'internal')));
    const { user } = renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Something went wrong' })).toBeInTheDocument();

    await user.tab();

    expect(screen.getByRole('link', { name: 'skip to content' })).toHaveFocus();
    expect(document.getElementById('main')).toBe(screen.getByRole('main'));
    expect(document.querySelector('.connection-banner')).toHaveAttribute('role', 'status');
  });

  it('moves focus to the recovered page’s h1 after "try again"', async () => {
    let failing = true;
    server.use(
      http.get(apiUrl('/me'), () => (failing ? problemResponse(500, 'internal') : HttpResponse.json({ user: MIRA }))),
    );
    const { user } = renderApp('/');
    const retry = await screen.findByRole('button', { name: 'try again' });

    failing = false;
    await user.click(retry);

    const heading = await screen.findByRole('heading', { level: 1, name: 'Profile' });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });

  it('names the network as the cause when the API cannot be reached', async () => {
    server.use(http.get(apiUrl('/me'), () => HttpResponse.error()));
    renderApp('/welcome');

    expect(await screen.findByRole('heading', { level: 1, name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(messageFor('network'));
  });
});

describe('RootLayout', () => {
  it('starts every page with the skip link to the main content (F-103)', async () => {
    signedIn();
    const { user } = renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();

    await user.tab();

    const skipLink = screen.getByRole('link', { name: 'skip to content' });
    expect(skipLink).toHaveFocus();
    expect(skipLink).toHaveAttribute('href', '#main');
    expect(document.getElementById('main')).toBe(screen.getByRole('main'));
  });

  it('has one main landmark and one h1 on app and welcome pages (F-103)', async () => {
    signedIn();
    renderApp('/chat');
    expect(await screen.findByRole('heading', { level: 1, name: 'Chat' })).toBeInTheDocument();

    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });

  it('leaves focus alone on the first page load', async () => {
    signedIn();
    renderApp('/');

    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });

  it('moves focus to the new page’s h1 after a client-side navigation (ADR-0013)', async () => {
    signedIn();
    const { user } = renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'online' }));

    const heading = await screen.findByRole('heading', { level: 1, name: 'Online' });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('renders the "Reconnecting…" live region on every page (F-107)', async () => {
    renderApp('/no-such-page');

    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});
