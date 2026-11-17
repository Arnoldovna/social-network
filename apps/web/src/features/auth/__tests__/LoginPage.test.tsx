import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createTestStore, MIRA } from '../../../shared/api/__tests__/fixtures';
import { getCsrfToken, setCsrfToken } from '../../../shared/api/csrf';
import { meApi } from '../../../shared/api/me.api';
import { apiUrl, csrfTokenHandler, http, HttpResponse, problemResponse, server } from '../../../shared/test/msw';
import { renderWithProviders } from '../../../shared/test/render';
import { LoginPage } from '../pages/LoginPage';

const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please log in again.';
const ROTATED_TOKEN = 'token-of-the-new-session';

function renderLoginPage(url = '/welcome/login') {
  const testStore = createTestStore();
  const rendered = renderWithProviders(<LoginPage />, {
    store: testStore.store,
    path: '/welcome/login',
    initialEntries: [url],
    routes: [
      { path: '/', element: <h1>Profile</h1> },
      { path: '/welcome', element: <h1>Sign up</h1> },
      { path: '/welcome/about', element: <h1>About</h1> },
    ],
  });
  return { ...rendered, actionsOfType: testStore.actionsOfType };
}

/** `POST /api/auth/login` answering 200 with the user and a new token; records every request body. */
function loginSucceeds() {
  const bodies: unknown[] = [];
  server.use(
    csrfTokenHandler(),
    http.post(apiUrl('/auth/login'), async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ user: MIRA, csrfToken: ROTATED_TOKEN });
    }),
  );
  return bodies;
}

async function logIn(user: ReturnType<typeof renderLoginPage>['user'], email: string, password: string) {
  await user.type(screen.getByLabelText('email'), email);
  await user.type(screen.getByLabelText('password'), password);
  await user.click(screen.getByRole('button', { name: 'log in' }));
}

describe('LoginPage', () => {
  it('F-05, F-12: sets the title and offers a real form with labelled email and current-password fields', () => {
    renderLoginPage();

    expect(document.title).toBe("Log in · Let's chat!");
    expect(screen.getByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.getByLabelText('email')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('email')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('F-22: ?reason=expired shows "Your session has expired. Please log in again." exactly once', () => {
    renderLoginPage('/welcome/login?reason=expired');

    expect(screen.getByRole('alert')).toHaveTextContent(SESSION_EXPIRED_MESSAGE);
    expect(screen.getAllByText(SESSION_EXPIRED_MESSAGE)).toHaveLength(1);
  });

  it('F-22: a visitor who opens the page without the reason never sees the expiry message', () => {
    renderLoginPage('/welcome/login?reason=other');

    expect(screen.queryByText(SESSION_EXPIRED_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('F-14: logs in with the parsed email, signs the user in, replaces the CSRF token and lands on /', async () => {
    setCsrfToken('token-of-the-visitor-session');
    const bodies = loginSucceeds();
    const { user, store, router } = renderLoginPage('/welcome/login?reason=expired');

    await logIn(user, ' Mira.Novak@Example.org ', ' a password with spaces ');

    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(bodies).toEqual([{ email: 'mira.novak@example.org', password: ' a password with spaces ' }]);
    expect(meApi.endpoints.getMe.select(undefined)(store.getState()).data).toEqual({ user: MIRA });
    expect(getCsrfToken()).toBe(ROTATED_TOKEN);
  });

  it('F-12: pressing Enter in the password field submits', async () => {
    const bodies = loginSucceeds();
    const { user } = renderLoginPage();

    await user.type(screen.getByLabelText('email'), 'mira.novak@example.org');
    await user.type(screen.getByLabelText('password'), 'quiet harbour lamps{Enter}');

    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
    expect(bodies).toHaveLength(1);
  });

  it('F-11: an empty submit names both missing fields in text and sends nothing', async () => {
    const bodies = loginSucceeds();
    const { user } = renderLoginPage();

    await user.click(screen.getByRole('button', { name: 'log in' }));

    expect(await screen.findByText('Please enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByLabelText('email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('password')).toHaveAccessibleDescription('Please enter your password.');
    expect(screen.getByLabelText('password')).toHaveAttribute('aria-invalid', 'true');
    expect(bodies).toHaveLength(0);
  });

  it('F-15: wrong credentials show "Email or password is incorrect." and never count as an expired session', async () => {
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/auth/login'), () =>
        problemResponse(401, 'invalid-credentials', { detail: 'Email or password is incorrect.' }),
      ),
    );
    const { user, router, store, actionsOfType } = renderLoginPage();

    await logIn(user, 'mira.novak@example.org', 'not the right password');

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(router.state.location.pathname).toBe('/welcome/login');
    expect(actionsOfType('session/expired')).toHaveLength(0);
    expect(meApi.endpoints.getMe.select(undefined)(store.getState()).data).toBeUndefined();
    // The values stay, so the user can correct the password without typing the email again.
    expect(screen.getByLabelText('email')).toHaveValue('mira.novak@example.org');
    expect(screen.getByRole('button', { name: 'log in' })).toBeEnabled();
  });

  it('F-13: a clicked submit that failed hands the focus to the form message instead of the page', async () => {
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/auth/login'), () => HttpResponse.error()),
    );
    const { user } = renderLoginPage();

    await logIn(user, 'mira.novak@example.org', 'quiet harbour lamps');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The server could not be reached. Check your connection and try again.');
    await waitFor(() => {
      expect(alert.parentElement).toHaveFocus();
    });
  });

  it('F-13: a second failed attempt announces the message again', async () => {
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/auth/login'), () => problemResponse(401, 'invalid-credentials')),
    );
    const { user } = renderLoginPage();

    await logIn(user, 'mira.novak@example.org', 'not the right password');
    const first = await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: 'log in' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).not.toBe(first);
    });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('F-96: links to sign up ("Not a member yet? Sign up") and to about', async () => {
    const { user, router } = renderLoginPage();

    const signUpItem = screen.getByText(/Not a member yet\?/);
    expect(within(signUpItem).getByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/welcome');
    expect(screen.getByRole('link', { name: 'About' })).toHaveAttribute('href', '/welcome/about');

    await user.click(screen.getByRole('link', { name: 'About' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'About' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/welcome/about');
  });
});
