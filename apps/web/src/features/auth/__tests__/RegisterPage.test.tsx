import type { RegisterBody } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createTestStore, MIRA } from '../../../shared/api/__tests__/fixtures';
import { getCsrfToken } from '../../../shared/api/csrf';
import { meApi } from '../../../shared/api/me.api';
import {
  apiUrl,
  csrfTokenHandler,
  http,
  HttpResponse,
  problemResponse,
  server,
  TEST_CSRF_TOKEN,
} from '../../../shared/test/msw';
import { renderWithProviders } from '../../../shared/test/render';
import { RegisterPage } from '../pages/RegisterPage';

const ROTATED_TOKEN = 'token-of-the-new-session';

const VALID_INPUT = {
  firstName: '  Mira ',
  lastName: 'Novak',
  email: ' Mira.Novak+chat@Example.org ',
  password: 'quiet harbour lamps',
};

function renderRegisterPage() {
  const testStore = createTestStore();
  const rendered = renderWithProviders(<RegisterPage />, {
    store: testStore.store,
    path: '/welcome',
    initialEntries: ['/welcome'],
    routes: [
      { path: '/', element: <h1>Profile</h1> },
      { path: '/welcome/login', element: <h1>Log in</h1> },
      { path: '/welcome/about', element: <h1>About</h1> },
    ],
  });
  return { ...rendered, actionsOfType: testStore.actionsOfType };
}

/** `POST /api/auth/register` answering 201 with the user and a new token; records every request it receives. */
function registerSucceeds() {
  const requests: { body: unknown; csrf: string | null }[] = [];
  server.use(
    csrfTokenHandler(),
    http.post(apiUrl('/auth/register'), async ({ request }) => {
      requests.push({ body: await request.json(), csrf: request.headers.get('x-csrf-token') });
      return HttpResponse.json({ user: MIRA, csrfToken: ROTATED_TOKEN }, { status: 201 });
    }),
  );
  return requests;
}

async function fillIn(user: ReturnType<typeof renderRegisterPage>['user'], input: Partial<RegisterBody>) {
  const fields: [string, string | undefined][] = [
    ['first name', input.firstName],
    ['last name', input.lastName],
    ['email', input.email],
    ['password', input.password],
  ];
  for (const [label, value] of fields) {
    if (value !== undefined) {
      await user.type(screen.getByLabelText(label), value);
    }
  }
}

describe('RegisterPage', () => {
  it('F-05: sets the document title and has one h1', () => {
    renderRegisterPage();

    expect(document.title).toBe("Sign up · Let's chat!");
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Sign up' })).toBeInTheDocument();
  });

  it('F-12, B-104: is a real form named by the heading, with visible labels, types and autocomplete', () => {
    renderRegisterPage();

    expect(screen.getByRole('form', { name: 'Sign up' })).toBeInTheDocument();
    const expected: [string, string, string][] = [
      ['first name', 'text', 'given-name'],
      ['last name', 'text', 'family-name'],
      ['email', 'email', 'email'],
      ['password', 'password', 'new-password'],
    ];
    for (const [label, type, autocomplete] of expected) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute('type', type);
      expect(input).toHaveAttribute('autocomplete', autocomplete);
      expect(input).toBeRequired();
    }
    expect(screen.getByRole('button', { name: 'sign up' })).toHaveAttribute('type', 'submit');
  });

  it('F-09: shows the password hint "At least 12 characters." linked to the field', () => {
    renderRegisterPage();

    expect(screen.getByLabelText('password')).toHaveAccessibleDescription('At least 12 characters.');
  });

  it('F-11, B-105: an empty submit shows text errors next to the fields, marks them invalid and sends nothing', async () => {
    const requests = registerSucceeds();
    const { user } = renderRegisterPage();

    await user.click(screen.getByRole('button', { name: 'sign up' }));

    const messages: [string, string][] = [
      ['first name', 'Please enter your first name.'],
      ['last name', 'Please enter your last name.'],
      ['email', 'Please enter a valid email address.'],
      ['password', 'Use at least 12 characters.'],
    ];
    for (const [label, message] of messages) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute('aria-invalid', 'true');
      // The error comes first in the description; the password field's hint follows it.
      expect(input).toHaveAccessibleDescription(new RegExp(`^${message.replaceAll('.', '\\.')}`));
    }
    expect(screen.getByText('Please enter your first name.')).toHaveAttribute('role', 'alert');
    // The first invalid field gets the focus, so keyboard users start where the problem is.
    expect(screen.getByLabelText('first name')).toHaveFocus();
    expect(requests).toHaveLength(0);
  });

  it('F-09: 11 characters are rejected in the form with the shared schema message; 12 are accepted', async () => {
    const requests = registerSucceeds();
    const { user } = renderRegisterPage();

    await fillIn(user, { ...VALID_INPUT, password: 'a'.repeat(11) });
    await user.click(screen.getByRole('button', { name: 'sign up' }));

    expect(await screen.findByText('Use at least 12 characters.')).toBeInTheDocument();
    expect(requests).toHaveLength(0);

    await user.type(screen.getByLabelText('password'), 'a');

    await waitFor(() => {
      expect(screen.queryByText('Use at least 12 characters.')).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('password')).not.toHaveAttribute('aria-invalid');
  });

  it('F-11: a name over 100 characters gets a plain sentence instead of the schema default', async () => {
    registerSucceeds();
    const { user } = renderRegisterPage();

    await fillIn(user, { ...VALID_INPUT, lastName: 'N'.repeat(101) });
    await user.click(screen.getByRole('button', { name: 'sign up' }));

    expect(await screen.findByText('Use at most 100 characters.')).toBeInTheDocument();
  });

  it('F-06: sends the parsed values with the CSRF token, signs the user in and lands on /', async () => {
    const requests = registerSucceeds();
    const { user, store, router } = renderRegisterPage();

    await fillIn(user, VALID_INPUT);
    await user.click(screen.getByRole('button', { name: 'sign up' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    expect(requests).toEqual([
      {
        // Trimmed and lower-cased by the shared schema (F-07, F-08); the password is never trimmed (F-09).
        body: {
          firstName: 'Mira',
          lastName: 'Novak',
          email: 'mira.novak+chat@example.org',
          password: 'quiet harbour lamps',
        },
        csrf: TEST_CSRF_TOKEN,
      },
    ]);
    // The user is in the getMe cache (signed in), and the token of the regenerated session replaced the old one.
    expect(meApi.endpoints.getMe.select(undefined)(store.getState()).data).toEqual({ user: MIRA });
    expect(getCsrfToken()).toBe(ROTATED_TOKEN);
  });

  it('F-12: pressing Enter in a field submits the form', async () => {
    const requests = registerSucceeds();
    const { user } = renderRegisterPage();

    await fillIn(user, VALID_INPUT);
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
    expect(requests).toHaveLength(1);
  });

  it('F-10: an existing email shows "An account with this email already exists." next to the email field', async () => {
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/auth/register'), () =>
        problemResponse(409, 'email-taken', {
          detail: 'Email already registered.',
          errors: [{ location: 'body', path: 'email', message: 'Email already registered.' }],
        }),
      ),
    );
    const { user, router, store } = renderRegisterPage();

    await fillIn(user, VALID_INPUT);
    await user.click(screen.getByRole('button', { name: 'sign up' }));

    const email = screen.getByLabelText('email');
    await waitFor(() => {
      expect(email).toHaveAttribute('aria-invalid', 'true');
    });
    expect(email).toHaveAccessibleDescription('An account with this email already exists.');
    expect(email).toHaveFocus();
    expect(screen.queryByText('Email already registered.')).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/welcome');
    expect(meApi.endpoints.getMe.select(undefined)(store.getState()).data).toBeUndefined();
    expect(screen.getByRole('button', { name: 'sign up' })).toBeEnabled();
  });

  it('F-11: server field errors (422) go next to the fields they name', async () => {
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/auth/register'), () =>
        problemResponse(422, 'validation-failed', {
          errors: [{ location: 'body', path: 'firstName', message: 'Please enter your first name.' }],
        }),
      ),
    );
    const { user } = renderRegisterPage();

    await fillIn(user, VALID_INPUT);
    await user.click(screen.getByRole('button', { name: 'sign up' }));

    await waitFor(() => {
      expect(screen.getByLabelText('first name')).toHaveAccessibleDescription('Please enter your first name.');
    });
    expect(screen.getByLabelText('first name')).toHaveAttribute('aria-invalid', 'true');
  });

  it('F-16: a rate limit shows one form-level sentence and keeps the input', async () => {
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/auth/register'), () =>
        problemResponse(429, 'rate-limited', {}, { headers: { 'retry-after': '600' } }),
      ),
    );
    const { user } = renderRegisterPage();

    await fillIn(user, VALID_INPUT);
    await user.click(screen.getByRole('button', { name: 'sign up' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests. Wait a moment and try again.');
    // The browser strips the spaces around an email input's value; the rest of the input stays as typed.
    expect(screen.getByLabelText('email')).toHaveValue(VALID_INPUT.email.trim());
    expect(screen.getByRole('button', { name: 'sign up' })).toBeEnabled();
  });

  it('F-13: the button is disabled and busy while the request runs; a double click creates one account', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests = vi.fn();
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/auth/register'), async () => {
        requests();
        await gate;
        return HttpResponse.json({ user: MIRA, csrfToken: ROTATED_TOKEN }, { status: 201 });
      }),
    );
    const { user } = renderRegisterPage();

    await fillIn(user, VALID_INPUT);
    await user.dblClick(screen.getByRole('button', { name: 'sign up' }));

    const busyButton = await screen.findByRole('button', { name: 'signing up…' });
    expect(busyButton).toBeDisabled();
    expect(screen.getByRole('form', { name: 'Sign up' })).toHaveAttribute('aria-busy', 'true');
    await user.click(busyButton);

    release();

    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
    expect(requests).toHaveBeenCalledTimes(1);
  });

  it('F-96: links to log in ("Already a member? Log in") and to about', async () => {
    const { user, router } = renderRegisterPage();

    const loginItem = screen.getByText(/Already a member\?/);
    expect(within(loginItem).getByRole('link', { name: 'log in' })).toHaveAttribute('href', '/welcome/login');
    expect(screen.getByRole('link', { name: 'about' })).toHaveAttribute('href', '/welcome/about');

    await user.click(within(loginItem).getByRole('link', { name: 'log in' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/welcome/login');
  });
});
