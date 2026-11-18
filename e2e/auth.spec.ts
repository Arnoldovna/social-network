import type { BrowserContext, Locator, Page, Request, Response } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothSchemes } from './a11y.js';
import { CSRF_HEADER, createApiClient, isRecord, logIn, newUserFields, type RegisterFields } from './fixtures/api.js';
import { observeRealtimeSockets, type ObservedSocket } from './fixtures/socket.js';
import { expect, test } from './fixtures/test.js';
import { fullName, mainNav, openHeaderPanelIfCollapsed, pageHeading, pageTitle } from './fixtures/ui.js';

/**
 * Registration, login, logout and session expiry through the UI (FEATURES §2, ADR-0012): F-06, F-10–F-14, F-20, F-22,
 * with the regression tests for B-11 (duplicate email) and B-18 (logout via GET).
 *
 * Each test registers its own users (through the UI or the API fixtures) with unique emails; nothing logs in as a
 * seeded account, and assertions only look at the test's own users, so the spec shares the e2e stack with the others.
 * Rate limits on the e2e stack are raised 100-fold; production limits are proven by the API integration tests.
 */

const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please log in again.';
const WRONG_CREDENTIALS_MESSAGE = 'Email or password is incorrect.';
const EMAIL_TAKEN_MESSAGE = 'An account with this email already exists.';

function isApiCall(method: string, path: string) {
  return (message: Request | Response): boolean => {
    const request = 'request' in message ? message.request() : message;
    return request.method() === method && new URL(request.url()).pathname === path;
  };
}

/** The register form, named by its "Sign up" heading (`aria-labelledby`), and its fields by their visible labels. */
function registerForm(page: Page) {
  const form = page.getByRole('form', { name: 'Sign up' });
  return {
    form,
    firstName: form.getByLabel('first name', { exact: true }),
    lastName: form.getByLabel('last name', { exact: true }),
    email: form.getByLabel('email', { exact: true }),
    password: form.getByLabel('password', { exact: true }),
    submit: form.getByRole('button', { name: /^sign(ing)? up/ }),
  };
}

function loginForm(page: Page) {
  const form = page.getByRole('form', { name: 'Log in' });
  return {
    form,
    email: form.getByLabel('email', { exact: true }),
    password: form.getByLabel('password', { exact: true }),
    submit: form.getByRole('button', { name: /^log(ging)? in/ }),
  };
}

async function fillRegisterForm(page: Page, fields: RegisterFields): Promise<void> {
  const form = registerForm(page);
  await form.firstName.fill(fields.firstName);
  await form.lastName.fill(fields.lastName);
  await form.email.fill(fields.email);
  await form.password.fill(fields.password);
}

/** The own profile at `/` (F-06, F-14): the user's full name is the page's `<h1>` and its title. */
async function expectOwnProfile(page: Page, user: { firstName: string; lastName: string }): Promise<void> {
  await expect(page).toHaveURL((url) => url.pathname === '/' && url.search === '');
  await expect(pageHeading(page, fullName(user))).toBeVisible();
  await expect(page).toHaveTitle(pageTitle(fullName(user)));
}

/** The server's view of the browser's session: `GET /api/me` with the context's cookies. */
async function signedInUserName(context: BrowserContext): Promise<string | null> {
  const response = await context.request.get('/api/me');
  if (response.status() === 401) return null;
  expect(response.status(), 'GET /api/me').toBe(200);
  const body: unknown = await response.json();
  const user = isRecord(body) ? body['user'] : undefined;
  if (isRecord(user) && typeof user['firstName'] === 'string' && typeof user['lastName'] === 'string') {
    return `${user['firstName']} ${user['lastName']}`;
  }
  throw new Error(`GET /api/me does not match the contract: ${JSON.stringify(body)}`);
}

/**
 * The session cookie's value, or null. Its name is app-scoped (`social-network.sid` on the plain-http e2e stack,
 * `__Host-social-network.sid` in production, conventions §8); only the `.sid` suffix is stable across both.
 */
async function sessionCookie(context: BrowserContext): Promise<string | null> {
  const cookie = (await context.cookies()).find(({ name }) => name.endsWith('.sid'));
  return cookie?.value ?? null;
}

async function expectOneConnectedSocket(sockets: ObservedSocket[]): Promise<void> {
  await expect
    .poll(() => sockets.filter((socket) => socket.connectedIds.length > 0 && !socket.closed).length, {
      message: 'the signed-in page should hold one connected socket',
    })
    .toBe(1);
}

async function expectAllSocketsClosed(sockets: ObservedSocket[]): Promise<void> {
  await expect.poll(() => sockets.filter((socket) => !socket.closed).length, { message: 'sockets still open' }).toBe(0);
}

/** The field shows `message` as text, is marked invalid and has the message as its accessible description (F-11). */
async function expectFieldError(field: Locator, message: string | RegExp): Promise<void> {
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(message);
}

async function expectFieldValid(field: Locator): Promise<void> {
  await expect(field).not.toHaveAttribute('aria-invalid', 'true');
}

// --- registration -------------------------------------------------------------------------------------------------

test.describe('registration', () => {
  test('F-06: a visitor registers and lands signed in on their own profile', async ({ page }) => {
    const fields = newUserFields({ firstName: 'Ada' });
    const sockets = observeRealtimeSockets(page);

    await page.goto('/welcome');
    await expect(pageHeading(page, 'Sign up')).toBeVisible();
    await fillRegisterForm(page, fields);
    const registered = page.waitForResponse(isApiCall('POST', '/api/auth/register'));
    await registerForm(page).submit.click();

    expect((await registered).status()).toBe(201);
    await expectOwnProfile(page, fields);
    // Signed in for real: the server knows the session, and the socket was accepted with it.
    expect(await signedInUserName(page.context())).toBe(fullName(fields));
    await expectOneConnectedSocket(sockets);
    await expectNoA11yViolationsInBothSchemes(page);
  });

  test('F-10, B-11: an existing email gets a 409 and the field message next to the email input', async ({
    page,
    createUser,
  }) => {
    const existing = await createUser();
    const fields = newUserFields({ email: existing.email });

    await page.goto('/welcome');
    await fillRegisterForm(page, fields);
    const conflict = page.waitForResponse(isApiCall('POST', '/api/auth/register'));
    await registerForm(page).submit.click();

    const response = await conflict;
    expect(response.status()).toBe(409);
    expect(response.headers()['content-type']).toContain('application/problem+json');
    const problem: unknown = await response.json();
    expect(problem).toMatchObject({ status: 409, errors: [{ path: 'email' }] });
    expect(isRecord(problem) && typeof problem['type'] === 'string' && problem['type'].endsWith(':email-taken')).toBe(
      true,
    );

    const form = registerForm(page);
    await expectFieldError(form.email, EMAIL_TAKEN_MESSAGE);
    await expect(form.email).toBeFocused();
    await expect(form.form.getByRole('alert')).toHaveText(EMAIL_TAKEN_MESSAGE);
    await expectFieldValid(form.firstName);
    await expectFieldValid(form.password);
    await expect(page).toHaveURL((url) => url.pathname === '/welcome');
    // Nothing was signed in by the failed attempt (legacy answered 200 `{success:false}`).
    expect(await signedInUserName(page.context())).toBeNull();
    await expectNoA11yViolationsInBothSchemes(page);

    // The form recovers: another email signs up with the values kept in the other fields.
    const fresh = newUserFields();
    await form.email.fill(fresh.email);
    await form.submit.click();
    await expectOwnProfile(page, fields);
    await expectNoA11yViolations(page);
  });

  test('F-11: invalid fields show their message as text, are announced and are never sent', async ({ page }) => {
    const registerRequests: Request[] = [];
    page.on('request', (request) => {
      if (isApiCall('POST', '/api/auth/register')(request)) registerRequests.push(request);
    });

    await page.goto('/welcome');
    const form = registerForm(page);
    await form.submit.click();

    await expectFieldError(form.firstName, 'Please enter your first name.');
    await expectFieldError(form.lastName, 'Please enter your last name.');
    await expectFieldError(form.email, 'Please enter a valid email address.');
    // The error is read before the hint; both stay linked to the input.
    await expectFieldError(form.password, /^Use at least 12 characters\.\s*At least 12 characters\.$/);
    for (const message of [
      'Please enter your first name.',
      'Please enter your last name.',
      'Please enter a valid email address.',
      'Use at least 12 characters.',
    ]) {
      await expect(form.form.getByRole('alert').filter({ hasText: message })).toBeVisible();
    }
    await expect(form.firstName).toBeFocused();
    await expectNoA11yViolationsInBothSchemes(page);

    // Correcting a touched field clears its error as the user types (shared schema, same rules as the API, F-09).
    const fields = newUserFields({ firstName: 'Lin' });
    await fillRegisterForm(page, { ...fields, email: 'not-an-email', password: 'eleven char' });
    await expectFieldValid(form.firstName);
    await expectFieldValid(form.lastName);
    await expectFieldError(form.email, /^Please enter a valid email address\./);
    await expectFieldError(form.password, /^Use at least 12 characters\./);
    await form.submit.click();
    await expect(page).toHaveURL((url) => url.pathname === '/welcome');
    expect(registerRequests, 'register requests sent for an invalid form').toHaveLength(0);

    // Exactly 12 characters is enough; the now valid form is sent once and signs the user in.
    await form.email.fill(fields.email);
    await form.password.fill('twelve chars');
    await expectFieldValid(form.email);
    await expectFieldValid(form.password);
    await form.submit.click();
    await expectOwnProfile(page, fields);
    expect(registerRequests).toHaveLength(1);
    await expectNoA11yViolations(page);
  });

  test('F-12, B-104: register and login are real forms with visible labels, types and autocomplete; Enter submits', async ({
    page,
  }) => {
    await page.goto('/welcome/login');
    const login = loginForm(page);
    await expect(login.form).toBeVisible();
    for (const [field, label, type, autocomplete] of [
      [login.email, 'email', 'email', 'email'],
      [login.password, 'password', 'password', 'current-password'],
    ] as const) {
      await expect(login.form.getByText(label, { exact: true })).toBeVisible();
      await expect(field).toHaveAttribute('type', type);
      await expect(field).toHaveAttribute('autocomplete', autocomplete);
    }
    await expect(login.submit).toHaveAttribute('type', 'submit');
    await expectNoA11yViolationsInBothSchemes(page);

    await page.goto('/welcome');
    const register = registerForm(page);
    for (const [field, label, type, autocomplete] of [
      [register.firstName, 'first name', 'text', 'given-name'],
      [register.lastName, 'last name', 'text', 'family-name'],
      [register.email, 'email', 'email', 'email'],
      [register.password, 'password', 'password', 'new-password'],
    ] as const) {
      await expect(register.form.getByText(label, { exact: true })).toBeVisible();
      await expect(field).toHaveAttribute('type', type);
      await expect(field).toHaveAttribute('autocomplete', autocomplete);
    }
    await expect(register.submit).toHaveAttribute('type', 'submit');
    await expect(register.form.getByText('At least 12 characters.', { exact: true })).toBeVisible();

    // Enter in the last field submits the form, as in any real `<form>` (legacy: div soup with click handlers).
    const fields = newUserFields({ firstName: 'Kemal' });
    await fillRegisterForm(page, fields);
    await register.password.press('Enter');
    await expectOwnProfile(page, fields);
    await expectNoA11yViolations(page);
  });

  test('F-13: while registering the button is disabled and busy; a double click creates one account', async ({
    baseURL,
    page,
  }) => {
    if (!baseURL) throw new Error('baseURL is not set (E2E_BASE_URL)');
    const fields = newUserFields({ firstName: 'Ines' });
    let registerCalls = 0;
    let releaseRegister: () => void = () => undefined;
    const registerHeld = new Promise<void>((resolve) => {
      releaseRegister = resolve;
    });
    // Hold the request in the browser so the busy state can be observed; it then goes to the real API unchanged.
    await page.route('**/api/auth/register', async (route) => {
      registerCalls += 1;
      await registerHeld;
      await route.continue();
    });

    await page.goto('/welcome');
    await fillRegisterForm(page, fields);
    const form = registerForm(page);
    await form.submit.dblclick();

    await expect(form.submit).toBeDisabled();
    await expect(form.submit).toHaveAccessibleName('signing up…');
    await expect(form.form).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => registerCalls).toBe(1);

    releaseRegister();
    await expectOwnProfile(page, fields);
    expect(registerCalls, 'register requests sent by a double click').toBe(1);

    // The account exists exactly as entered: registering the email again is a conflict.
    const probe = await createApiClient(baseURL);
    try {
      await probe.refreshCsrfToken();
      const again = await probe.post('/api/auth/register', { ...newUserFields(), email: fields.email });
      expect(again.status()).toBe(409);
    } finally {
      await probe.dispose();
    }
    await expectNoA11yViolations(page);
  });
});

// --- login --------------------------------------------------------------------------------------------------------

test.describe('login', () => {
  test('F-14: a visitor logs in and lands on their profile; session id and CSRF token rotate', async ({
    page,
    createUser,
  }) => {
    const account = await createUser({ firstName: 'Tomás' });
    const context = page.context();
    const sockets = observeRealtimeSockets(page);

    await page.goto('/welcome/login');
    await expect(pageHeading(page, 'Log in')).toBeVisible();
    // An anonymous session with its token, as a visitor's browser has after any form request (ADR-0005).
    const anonymous = await context.request.get('/api/csrf-token');
    expect(anonymous.status()).toBe(200);
    const anonymousBody: unknown = await anonymous.json();
    const anonymousToken = isRecord(anonymousBody) ? anonymousBody['token'] : undefined;
    expect(typeof anonymousToken).toBe('string');
    const anonymousSession = await sessionCookie(context);
    expect(anonymousSession).not.toBeNull();

    const form = loginForm(page);
    await form.email.fill(account.email);
    await form.password.fill(account.password);
    const loggedIn = page.waitForResponse(isApiCall('POST', '/api/auth/login'));
    await form.submit.click();

    expect((await loggedIn).status()).toBe(200);
    await expectOwnProfile(page, account);
    await expectOneConnectedSocket(sockets);

    // F-18: login regenerated the session, so the anonymous id and the token bound to it are dead.
    const signedInSession = await sessionCookie(context);
    expect(signedInSession).not.toBeNull();
    expect(signedInSession).not.toBe(anonymousSession);
    const staleToken = await context.request.post('/api/auth/logout', {
      headers: { [CSRF_HEADER]: String(anonymousToken) },
    });
    expect(staleToken.status()).toBe(403);
    expect(await signedInUserName(context)).toBe(fullName(account));
    await expectNoA11yViolationsInBothSchemes(page);
  });

  test('F-14: wrong credentials keep the visitor on the form with one generic message', async ({
    page,
    createUser,
  }) => {
    const account = await createUser({ firstName: 'Priya' });

    await page.goto('/welcome/login');
    const form = loginForm(page);

    for (const [step, email, password] of [
      ['wrong password', account.email, `${account.password} but wrong`],
      ['unknown email', newUserFields().email, account.password],
    ] as const) {
      await test.step(step, async () => {
        await form.email.fill(email);
        await form.password.fill(password);
        const rejected = page.waitForResponse(isApiCall('POST', '/api/auth/login'));
        await form.submit.click();

        expect((await rejected).status()).toBe(401);
        await expect(form.form.getByRole('alert')).toHaveText(WRONG_CREDENTIALS_MESSAGE);
        // The submit button was disabled while busy; focus moves to the message instead of the document.
        await expect(page.locator(':focus')).toHaveText(WRONG_CREDENTIALS_MESSAGE);
        await expect(form.submit).toBeEnabled();
        await expect(page).toHaveURL((url) => url.pathname === '/welcome/login');
      });
    }
    await expectNoA11yViolations(page);

    await form.email.fill(account.email);
    await form.password.fill(account.password);
    await form.password.press('Enter');
    await expectOwnProfile(page, account);
    await expectNoA11yViolations(page);
  });
});

// --- logout and session end ---------------------------------------------------------------------------------------

test.describe('logout and session end', () => {
  test('F-20, B-18: "log out" posts with CSRF, ends the session and the socket, and lands on the login page', async ({
    user,
    pageAs,
  }) => {
    const page = await pageAs(user);
    const context = page.context();
    const sockets = observeRealtimeSockets(page);
    await page.goto('/');
    await expectOwnProfile(page, user);
    await expectOneConnectedSocket(sockets);
    const sessionBefore = await sessionCookie(context);
    expect(sessionBefore).not.toBeNull();

    await openHeaderPanelIfCollapsed(page);
    const logout = page.waitForResponse(isApiCall('POST', '/api/auth/logout'));
    await page.getByRole('banner').getByRole('button', { name: 'log out', exact: true }).click();

    const response = await logout;
    expect(response.status()).toBe(204);
    expect(response.request().headers()[CSRF_HEADER], 'CSRF header on the logout request').toBeTruthy();
    await expect(page).toHaveURL((url) => url.pathname === '/welcome/login' && url.search === '');
    await expect(pageHeading(page, 'Log in')).toBeVisible();
    await expect(page.getByText(SESSION_EXPIRED_MESSAGE)).toHaveCount(0);
    await expectAllSocketsClosed(sockets);

    // The cookie is cleared and the server session is gone: the old cookie (still held by the API client that shares
    // it) no longer signs anybody in, and the app area sends the browser back to the welcome page.
    await expect.poll(() => sessionCookie(context)).not.toBe(sessionBefore);
    expect((await user.api.get('/api/me')).status()).toBe(401);
    await page.goto('/');
    await expect(page).toHaveURL((url) => url.pathname === '/welcome');
    await expect(pageHeading(page, 'Sign up')).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('B-18: logout is never a GET and never works without the CSRF token', async ({ user }) => {
    const viaGet = await user.api.get('/api/auth/logout');
    expect(viaGet.status()).toBe(404);
    expect(viaGet.headers()['content-type']).toContain('application/problem+json');

    // A cross-site form or `<img src>` cannot read the token, so a forged logout fails with 403 `csrf-invalid`.
    const forged = await user.api.post('/api/auth/logout', undefined, { csrf: false });
    expect(forged.status()).toBe(403);
    const problem: unknown = await forged.json();
    expect(isRecord(problem) && typeof problem['type'] === 'string' && problem['type'].endsWith(':csrf-invalid')).toBe(
      true,
    );

    // Neither request ended the session.
    expect((await user.api.get('/api/me')).status()).toBe(200);
  });

  test('F-22: when the session has expired, the next API call sends the page to log in with a message', async ({
    baseURL,
    user,
    pageAs,
  }) => {
    if (!baseURL) throw new Error('baseURL is not set (E2E_BASE_URL)');
    // A session cookie whose server session no longer exists, which is what an expired session looks like to the API:
    // log the user in on a second client, keep its cookies, and end that session.
    const secondDevice = await logIn(baseURL, user);
    const expiredCookies = (await secondDevice.storageState()).cookies;
    try {
      expect((await secondDevice.post('/api/auth/logout')).status()).toBe(204);
    } finally {
      await secondDevice.dispose();
    }

    const page = await pageAs(user);
    const sockets = observeRealtimeSockets(page);
    // Every answer of the session renews its cookie (rolling sessions), so a request still in flight when the cookie is
    // swapped below would put the live cookie back. The profile page's own requests must have answered first.
    const settled = Promise.all(
      ['/api/me', `/api/users/${String(user.id)}/posts`, '/api/friendships'].map((path) =>
        page.waitForResponse((response) => new URL(response.url()).pathname === path),
      ),
    );
    await page.goto('/');
    await expectOwnProfile(page, user);
    await expectOneConnectedSocket(sockets);
    await settled;

    // The session runs out while the page is open. The socket keeps its handshake until the server's sweep, so only
    // the next HTTP request notices.
    await page.context().addCookies(expiredCookies);
    const unauthorized = page.waitForResponse(
      (response) => new URL(response.url()).pathname.startsWith('/api/') && response.status() === 401,
    );
    // A client-side navigation (a reload would only ask `GET /api/me`, which treats a 401 as "visitor"): the chat page
    // loads its history, and that request answers 401.
    await openHeaderPanelIfCollapsed(page);
    await mainNav(page).getByRole('link', { name: 'chat', exact: true }).click();

    await unauthorized;
    await expect(page).toHaveURL((url) => url.pathname === '/welcome/login' && url.search === '?reason=expired');
    await expect(pageHeading(page, 'Log in')).toBeVisible();
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(SESSION_EXPIRED_MESSAGE);
    await expect(page.getByText('Reconnecting…')).toHaveCount(0);
    await expectNoA11yViolationsInBothSchemes(page);

    // "Please log in again" works from right there.
    const form = loginForm(page);
    await form.email.fill(user.email);
    await form.password.fill(user.password);
    await form.submit.click();
    await expectOwnProfile(page, user);
    await expectNoA11yViolations(page);
  });

  test('F-22: a session ended on the server while the page is open is noticed through the socket', async ({
    user,
    pageAs,
  }) => {
    const page = await pageAs(user);
    const sockets = observeRealtimeSockets(page);
    await page.goto('/');
    await expectOwnProfile(page, user);
    await expectOneConnectedSocket(sockets);

    // The same session ends elsewhere (another tab of this browser logs out); the server disconnects its sockets.
    expect((await user.api.post('/api/auth/logout')).status()).toBe(204);

    await expect(page).toHaveURL((url) => url.pathname === '/welcome/login' && url.search === '?reason=expired');
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(SESSION_EXPIRED_MESSAGE);
    await expectAllSocketsClosed(sockets);
    expect(await signedInUserName(page.context())).toBeNull();
    await expectNoA11yViolations(page);
  });
});
