import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import type { Page, Request } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothSchemes } from './a11y.js';
import { isRecord } from './fixtures/api.js';
import { observeRealtimeSockets, type ObservedSocket } from './fixtures/socket.js';
import { expect, test } from './fixtures/test.js';
import {
  documentMarker,
  fullName,
  mainNav,
  markDocument,
  openHeaderPanelIfCollapsed,
  pageHeading,
  pageTitle,
} from './fixtures/ui.js';

/**
 * Routing journeys (FEATURES §1, ADR-0013): the route guards (F-01, F-02), the one data router with real paths whose
 * client-side navigation keeps the document and the real-time socket (F-03, B-79, B-140), the not-found page and the
 * API's 404 problem (F-04, B-57), and the document titles (F-05).
 *
 * Every user is registered by the spec itself through the API fixtures; assertions only look at that user's own
 * content (its name, its own pages), never at seed data, so the spec shares the e2e stack with the other units.
 */

/** The app pages a visitor must never see (F-01); `/users/:id` is added per test with a real id. */
const PROTECTED_PATHS = ['/', '/friends', '/online', '/chat'] as const;

/** The visitor pages a signed-in user must never see (F-02). */
const WELCOME_PATHS = ['/welcome', '/welcome/login', '/welcome/about'] as const;

function pathOf(page: Page): string {
  return new URL(page.url()).pathname;
}

/** Clicks an item of the main navigation ("profile / friends / online / chat", F-92), as a user would. */
async function clickMainNav(page: Page, label: 'profile' | 'friends' | 'online' | 'chat'): Promise<void> {
  await openHeaderPanelIfCollapsed(page);
  await mainNav(page).getByRole('link', { name: label, exact: true }).click();
}

/**
 * The main navigation link marked `aria-current="page"` (F-93). Below 640 px the navigation sits in the closed "menu"
 * panel, which hides it from the accessibility tree until opened, so this looks at hidden elements too: the marking
 * is what is checked here, the panel itself belongs to the layout spec.
 */
function currentNavLink(page: Page) {
  return page
    .getByRole('navigation', { name: 'Main', includeHidden: true })
    .getByRole('link', { includeHidden: true })
    .and(page.locator('[aria-current="page"]'));
}

// --- real-time socket ---------------------------------------------------------------------------------------------

/** Waits until the page's socket reached `connected` once and returns its socket id. */
async function connectedSocketId(sockets: ObservedSocket[]): Promise<string> {
  await expect
    .poll(() => sockets.flatMap((socket) => socket.connectedIds), {
      message: 'the signed-in page should open one socket and reach `connected`',
    })
    .toHaveLength(1);
  const [id] = sockets.flatMap((socket) => socket.connectedIds);
  return id!;
}

/**
 * A round trip through the page. Playwright delivers the browser's events in order, so any WebSocket the navigation
 * before this call created or closed has been recorded by the time it returns.
 */
async function flushBrowserEvents(page: Page): Promise<void> {
  await page.evaluate(() => document.readyState);
}

/** The level-1 heading and the document title each app page shows (F-05). */
async function expectAppPage(page: Page, path: string, heading: string, documentTitle: string): Promise<void> {
  await expect(page).toHaveURL((url) => url.pathname === path && url.hash === '');
  await expect(pageHeading(page, heading)).toBeVisible();
  await expect(page).toHaveTitle(documentTitle);
}

// --- F-01, F-02: guards -------------------------------------------------------------------------------------------

test.describe('route guards', () => {
  test('F-01: a visitor who requests any app page lands on /welcome without seeing it', async ({
    page,
    createUser,
  }) => {
    // A real profile id, so the redirect cannot be explained by "this user does not exist".
    const someone = await createUser();
    const apiPaths: string[] = [];
    page.on('request', (request: Request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/api/')) apiPaths.push(pathname);
    });

    for (const path of [...PROTECTED_PATHS, `/users/${String(someone.id)}`]) {
      await test.step(path, async () => {
        await page.goto(path);

        await expect(page).toHaveURL((url) => url.pathname === '/welcome' && url.search === '' && url.hash === '');
        await expect(pageHeading(page, 'Sign up')).toBeVisible();
        await expect(mainNav(page)).toHaveCount(0);
      });
    }

    // The guard asked who is signed in and nothing else: no page of the app area started loading its data.
    expect(
      apiPaths.filter((path) => path !== '/api/me'),
      'API requests made while redirecting',
    ).toEqual([]);
    await expectNoA11yViolationsInBothSchemes(page);
  });

  test('F-02: a signed-in user who requests any /welcome page lands on their own profile', async ({
    user,
    userPage: page,
  }) => {
    for (const path of WELCOME_PATHS) {
      await test.step(path, async () => {
        await page.goto(path);

        await expectAppPage(page, '/', fullName(user), pageTitle(fullName(user)));
        await expect(page.getByRole('heading', { name: /^(sign up|log in|about)$/i })).toHaveCount(0);
      });
    }

    await expectNoA11yViolations(page);
  });
});

// --- F-03, B-79, B-140: one router, one document, one socket ------------------------------------------------------

test.describe('client-side navigation', () => {
  test('F-03, B-79: navigating the app reaches `connected` once and keeps the same socket id and document', async ({
    user,
    pageAs,
  }) => {
    const page = await pageAs(user);
    const sockets = observeRealtimeSockets(page);

    await page.goto('/');
    await expectAppPage(page, '/', fullName(user), pageTitle(fullName(user)));
    const socketId = await connectedSocketId(sockets);
    const marker = await markDocument(page);

    const journey = [
      { nav: 'friends', path: '/friends', heading: 'Friends', documentTitle: pageTitle('Friends') },
      { nav: 'online', path: '/online', heading: 'Online', documentTitle: pageTitle('Online') },
      { nav: 'chat', path: '/chat', heading: 'Chat', documentTitle: pageTitle('Chat') },
      { nav: 'profile', path: '/', heading: fullName(user), documentTitle: pageTitle(fullName(user)) },
    ] as const;

    for (const step of journey) {
      await test.step(`main navigation: ${step.nav}`, async () => {
        await clickMainNav(page, step.nav);
        await expectAppPage(page, step.path, step.heading, step.documentTitle);
        await expect(currentNavLink(page)).toHaveText(step.nav);
      });
    }

    await test.step('back and forward stay in the document', async () => {
      await page.goBack();
      await expectAppPage(page, '/chat', 'Chat', pageTitle('Chat'));
      await page.goBack();
      await expectAppPage(page, '/online', 'Online', pageTitle('Online'));
      await page.goForward();
      await expectAppPage(page, '/chat', 'Chat', pageTitle('Chat'));
    });

    await test.step('the wordmark leads home', async () => {
      await page.getByRole('banner').getByRole('link', { name: "let's chat", exact: true }).click();
      await expectAppPage(page, '/', fullName(user), pageTitle(fullName(user)));
    });

    await flushBrowserEvents(page);
    expect(await documentMarker(page), 'the document was reloaded during navigation').toBe(marker);
    expect(sockets, 'WebSockets opened by the page').toHaveLength(1);
    expect(sockets[0]!.closed, 'the socket was closed during navigation').toBe(false);
    expect(sockets[0]!.connectedIds, 'socket ids the page was connected with').toEqual([socketId]);
    await expect(page.getByText('Reconnecting…')).toHaveCount(0);
    await expectNoA11yViolationsInBothSchemes(page);
  });

  test('B-140: one router with real paths serves deep links and in-app links alike, no hash routes', async ({
    page,
  }) => {
    // Deep links into the visitor area render the right page directly (nginx falls back to the SPA shell).
    await page.goto('/welcome/about');
    await expect(page).toHaveURL((url) => url.pathname === '/welcome/about' && url.hash === '');
    await expect(pageHeading(page, 'About')).toBeVisible();
    const marker = await markDocument(page);

    // In-app links move between the same real paths without a reload (legacy: HashRouter, `#/login`).
    await page.getByRole('main').getByRole('link', { name: 'log in', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/welcome/login' && url.hash === '');
    await expect(pageHeading(page, 'Log in')).toBeVisible();

    await page.getByRole('main').getByRole('link', { name: 'sign up', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/welcome' && url.hash === '');
    await expect(pageHeading(page, 'Sign up')).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === '/welcome/login');
    await expect(pageHeading(page, 'Log in')).toBeVisible();
    expect(await documentMarker(page), 'the document was reloaded during navigation').toBe(marker);

    // A reload of an in-app URL lands on the same page: the path is the state, not a hash.
    await page.reload();
    await expect(pageHeading(page, 'Log in')).toBeVisible();
    expect(await documentMarker(page)).toBeNull();
    await expectNoA11yViolations(page);
  });

  test('B-140: a signed-in deep link renders the page inside the app layout', async ({ userPage: page }) => {
    await page.goto('/friends');

    await expectAppPage(page, '/friends', 'Friends', pageTitle('Friends'));
    await expect(currentNavLink(page)).toHaveText('friends');
    await expectNoA11yViolations(page);
  });
});

// --- F-04, B-57: not found ----------------------------------------------------------------------------------------

test.describe('not found', () => {
  test('F-04: a visitor on an unknown path sees "Page not found" with a link back to the start', async ({ page }) => {
    const response = await page.goto(`/no-such-page-${randomUUID()}`);

    // nginx serves the SPA shell for every non-file path; the router renders its own 404 page.
    expect(response?.status()).toBe(200);
    await expect(pageHeading(page, 'Page not found')).toBeVisible();
    await expect(page).toHaveTitle(pageTitle('Page not found'));
    // The visitor shell: wordmark and footer, no site navigation (ADR-0013).
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await expect(page.getByRole('contentinfo')).toBeVisible();
    await expectNoA11yViolationsInBothSchemes(page);

    // The start page is `/`, which sends a visitor on to the welcome page (F-01).
    await page
      .getByRole('main')
      .getByRole('link', { name: /back to the start page/i })
      .click();
    await expect(page).toHaveURL((url) => url.pathname === '/welcome');
    await expect(pageHeading(page, 'Sign up')).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('F-04: a signed-in user on an unknown path gets back to their own profile', async ({ user, userPage: page }) => {
    await page.goto(`/users/${String(user.id)}/no-such-tab`);

    await expect(pageHeading(page, 'Page not found')).toBeVisible();
    await expect(page).toHaveTitle(pageTitle('Page not found'));
    // Inside the app layout (ADR-0013): the site header is there (below 640 px its navigation is behind "menu"), so
    // the user is never stranded. The avatar button is in the bar at every width.
    await expect(page.getByRole('banner').getByRole('button', { name: 'change profile picture' })).toBeVisible();
    await expectNoA11yViolations(page);
    await page
      .getByRole('main')
      .getByRole('link', { name: /back to the start page/i })
      .click();

    await expectAppPage(page, '/', fullName(user), pageTitle(fullName(user)));
    await expectNoA11yViolations(page);
  });

  test('F-04, B-57: unknown /api paths answer 404 problem+json, never the HTML shell', async ({ request, user }) => {
    const paths = [`/api/no-such-route-${randomUUID()}`, `/api/auth/no-such-route-${randomUUID()}`];

    for (const path of paths) {
      await test.step(`anonymous GET ${path}`, async () => {
        const response = await request.get(path);

        expect(response.status()).toBe(404);
        expect(response.headers()['content-type']).toContain('application/problem+json');
        const body: unknown = await response.json();
        expect(body).toMatchObject({ status: 404, title: 'Not found', instance: path });
        expect(isRecord(body) && typeof body['type'] === 'string' && body['type'].endsWith(':not-found')).toBe(true);
        expect(await response.text()).not.toContain('<html');
      });
    }

    await test.step('signed in, same answer', async () => {
      const response = await user.api.get(paths[0]!);
      expect(response.status()).toBe(404);
      expect(response.headers()['content-type']).toContain('application/problem+json');
    });
  });

  test('B-57: a missing static asset is a 404, not the SPA shell', async ({ request }) => {
    const response = await request.get(`/assets/no-such-file-${randomUUID()}.js`);

    // `/assets/` has no SPA fallback (`try_files $uri =404`), so a typo never "succeeds" with index.html.
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain('<div id="root">');
  });
});

// --- F-05: titles -------------------------------------------------------------------------------------------------

test.describe('document titles', () => {
  test('F-05: every visitor page sets a meaningful title', async ({ page }) => {
    const pages = [
      { path: '/welcome', heading: 'Sign up', documentTitle: pageTitle('Sign up') },
      { path: '/welcome/login', heading: 'Log in', documentTitle: pageTitle('Log in') },
      { path: '/welcome/about', heading: 'About', documentTitle: pageTitle('About') },
    ];

    for (const { path, heading, documentTitle } of pages) {
      await test.step(path, async () => {
        await page.goto(path);
        await expect(pageHeading(page, heading)).toBeVisible();
        await expect(page).toHaveTitle(documentTitle);
      });
    }
    await expectNoA11yViolationsInBothSchemes(page);
  });

  test('F-05: every app page sets a meaningful title, profiles carry the person’s name', async ({
    user,
    createUser,
    userPage: page,
  }) => {
    const other = await createUser({ firstName: 'Noor' });
    const pages = [
      { path: '/', heading: fullName(user), documentTitle: pageTitle(fullName(user)) },
      { path: '/friends', heading: 'Friends', documentTitle: pageTitle('Friends') },
      { path: '/online', heading: 'Online', documentTitle: pageTitle('Online') },
      { path: '/chat', heading: 'Chat', documentTitle: pageTitle('Chat') },
      { path: `/users/${String(other.id)}`, heading: fullName(other), documentTitle: pageTitle(fullName(other)) },
      // Not a valid id: the client shows "does not exist" without asking the API (F-42).
      { path: '/users/0', heading: 'This user does not exist.', documentTitle: pageTitle('User not found') },
    ];

    for (const { path, heading, documentTitle } of pages) {
      await test.step(path, async () => {
        await page.goto(path);
        await expectAppPage(page, path, heading, documentTitle);
      });
    }
    expect(pathOf(page)).toBe('/users/0');
    await expectNoA11yViolations(page);
  });
});

// --- the stack: shell, assets, headers, socket path -----------------------------------------------------------------

/** Engine.IO v4 over WebSocket only (ADR-0008): no polling handshake, so the first request is the upgrade itself. */
const SOCKET_PATH = '/socket.io/?EIO=4&transport=websocket';

/**
 * How long a raw socket check waits for the server. Well below the test timeout, so a hung upstream or a missing
 * upgrade config fails with the case that got no answer instead of a bare "Test timeout exceeded".
 */
const SOCKET_ANSWER_TIMEOUT_MS = 10_000;

interface SocketTranscript {
  /** Text frames from the server, in order. */
  frames: string[];
  /** Set when the server or the network closed the socket before the namespace answer arrived. */
  closedEarly: { code: number; reason: string } | null;
  errored: boolean;
  /** No namespace answer and no close within SOCKET_ANSWER_TIMEOUT_MS. */
  timedOut: boolean;
}

/**
 * Status of a raw WebSocket upgrade request through nginx with the given `Origin` (or none): 101 when the API accepts
 * the handshake, otherwise the status engine.io's `allowRequest` answers with. Node's client lets the test set
 * `Origin`, which a page cannot. Rejects, naming the origin, when no answer arrives within SOCKET_ANSWER_TIMEOUT_MS.
 */
function upgradeStatus(baseURL: string, origin: string | null): Promise<number> {
  const url = new URL(SOCKET_PATH, baseURL);
  if (url.protocol !== 'http:') throw new Error(`upgradeStatus supports http only, got ${url.protocol}`);
  const originLabel = origin === null ? 'no Origin header' : `Origin ${origin}`;
  return new Promise((resolve, reject) => {
    const upgrade = httpRequest(url, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...(origin === null ? {} : { Origin: origin }),
      },
      timeout: SOCKET_ANSWER_TIMEOUT_MS,
    });
    upgrade.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    upgrade.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    // `timeout` only reports the idle socket; destroying the request settles the promise through 'error'.
    upgrade.on('timeout', () => {
      upgrade.destroy(
        new Error(`no answer to the upgrade with ${originLabel} within ${String(SOCKET_ANSWER_TIMEOUT_MS)} ms`),
      );
    });
    upgrade.on('error', (error) => {
      reject(new Error(`upgrade request with ${originLabel} failed: ${error.message}`, { cause: error }));
    });
    upgrade.end();
  });
}

/** Every `src`/`href` of a `<script>` or `<link>` in the shell that points at this origin. */
function shellAssetPaths(html: string): string[] {
  return [...html.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)="(\/[^"]*)"/g)].map((match) => match[1]!);
}

/** Every same-origin `url(...)` in a stylesheet (the self-hosted font files). */
function stylesheetUrlPaths(css: string): string[] {
  return [...css.matchAll(/url\(\s*["']?(\/[^"')]+)["']?\s*\)/g)].map((match) => match[1]!);
}

/** The media type nginx must send for a built asset, by extension. */
const ASSET_CONTENT_TYPES: Record<string, RegExp> = {
  '.js': /^(?:text|application)\/javascript/,
  '.css': /^text\/css/,
  '.svg': /^image\/svg\+xml/,
  '.woff2': /^font\/woff2/,
  '.woff': /^font\/woff/,
};

function expectedContentType(path: string): RegExp {
  const extension = /\.[a-z0-9]+$/.exec(path)?.[0] ?? '';
  const type = ASSET_CONTENT_TYPES[extension];
  if (type === undefined) throw new Error(`no expected content type for ${path}`);
  return type;
}

test.describe('the stack behind the routes', () => {
  test('F-114: the API is ready behind nginx', async ({ request }) => {
    const response = await request.get('/health/ready');

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('F-109, B-59, B-107: / serves the SPA shell with lang="en", a strict CSP and the security headers', async ({
    request,
  }) => {
    const response = await request.get('/');

    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers['content-type']).toContain('text/html');
    // The policy must exist and must not allow inline scripts (B-107), otherwise the console check proves nothing.
    // connect-src 'self' is what lets the same-origin WebSocket below through (ADR-0019 §6).
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    // B-59: the rest of the header set nginx adds (apps/web/nginx.conf); nothing names the server stack.
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-powered-by']).toBeUndefined();
    expect(headers['server'] ?? '').not.toMatch(/\d/);
    expect(await response.text()).toMatch(/<html lang="en">/);
  });

  test('B-08: every script, style, icon and font the shell references is served from the built client', async ({
    request,
  }) => {
    const shell = await request.get('/');
    expect(shell.status()).toBe(200);
    const shellPaths = shellAssetPaths(await shell.text());
    expect(shellPaths.filter((path) => path.endsWith('.js')).length, 'module scripts in the shell').toBeGreaterThan(0);
    expect(shellPaths.filter((path) => path.endsWith('.css')).length, 'stylesheets in the shell').toBeGreaterThan(0);

    const fontPaths: string[] = [];
    for (const path of shellPaths) {
      await test.step(path, async () => {
        const response = await request.get(path);
        expect(response.status(), path).toBe(200);
        expect(response.headers()['content-type'], path).toMatch(expectedContentType(path));
        if (path.endsWith('.css')) fontPaths.push(...stylesheetUrlPaths(await response.text()));
      });
    }

    // The font files only the stylesheet names (Schibsted Grotesk, self-hosted): the same directory serves them.
    expect(fontPaths.filter((path) => path.endsWith('.woff2')).length, 'woff2 fonts in the stylesheet').toBeGreaterThan(
      0,
    );
    for (const path of new Set(fontPaths)) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expect(response.headers()['content-type'], path).toMatch(expectedContentType(path));
    }
  });

  test('F-109: the page renders without CSP violations or uncaught errors', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    const response = await page.goto('/');

    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // React rendered a page, so the module script and the stylesheet were allowed to load.
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
    // Fonts load lazily once text uses them; wait until they settle so a blocked font-src is already reported to the
    // fixture's CSP check before the test ends.
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await expect
      .poll(() => page.evaluate(() => [...document.fonts].some((font) => font.status === 'loaded')))
      .toBe(true);

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    await expectNoA11yViolations(page);
  });

  test('F-01: a visitor gets 401 from /api/me and stays on the welcome page, axe clean in light and dark mode', async ({
    page,
  }) => {
    // The guard's `GET /api/me` must answer 401 (a visitor, ADR-0013). Any other answer sends the page to
    // RouteErrorPage, which also has a level-1 heading in `main`, so the heading alone would not prove the welcome page.
    const meResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/me' && response.request().method() === 'GET',
    );
    await page.goto('/welcome');
    expect((await meResponse).status()).toBe(401);

    await expect(page).toHaveURL(/\/welcome$/);
    await expect(pageHeading(page, 'Sign up')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0);
    await expectNoA11yViolationsInBothSchemes(page);
  });

  test('B-38: an anonymous socket through nginx is upgraded, then rejected as unauthorized', async ({ page }) => {
    // Any page of the app gives the WebSocket the app's origin, which the e2e stack allow-lists (ADR-0016).
    await page.goto('/');

    const transcript = await page.evaluate(
      async ({ path, timeoutMs }): Promise<SocketTranscript> => {
        const url = new URL(path, window.location.href);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(url);
        const frames: string[] = [];
        let errored = false;
        return new Promise((resolve) => {
          // The first call wins; later events (the close after our own close()) change nothing.
          const timer = setTimeout(() => {
            socket.close();
            resolve({ frames, closedEarly: null, errored, timedOut: true });
          }, timeoutMs);
          const finish = (closedEarly: SocketTranscript['closedEarly']) => {
            clearTimeout(timer);
            resolve({ frames, closedEarly, errored, timedOut: false });
          };
          socket.addEventListener('message', (event: MessageEvent<unknown>) => {
            const frame = typeof event.data === 'string' ? event.data : `<binary frame>`;
            frames.push(frame);
            // Engine.IO open packet: ask for the default namespace like socket.io-client does (Socket.IO CONNECT).
            if (frame.startsWith('0')) socket.send('40');
            // Socket.IO CONNECT_ERROR for the default namespace: the handshake middleware's answer.
            if (frame.startsWith('44')) {
              socket.close();
              finish(null);
            }
          });
          socket.addEventListener('error', () => {
            errored = true;
          });
          socket.addEventListener('close', (event) => {
            finish({ code: event.code, reason: event.reason });
          });
        });
      },
      { path: SOCKET_PATH, timeoutMs: SOCKET_ANSWER_TIMEOUT_MS },
    );

    // No error and no early close: nginx upgraded the request, the origin passed `allowRequest` (B-07) and the CSP
    // allowed the connection (a CSP block would also fail the fixture's console check).
    expect(transcript.timedOut, JSON.stringify(transcript)).toBe(false);
    expect(transcript.errored, JSON.stringify(transcript)).toBe(false);
    expect(transcript.closedEarly, JSON.stringify(transcript)).toBeNull();
    const [openPacket, connectError, ...rest] = transcript.frames;

    expect(openPacket).toMatch(/^0\{/);
    const handshake: unknown = JSON.parse(openPacket!.slice(1));
    expect(handshake).toMatchObject({ upgrades: [] }); // WebSocket only: nothing left to upgrade to
    expect(handshake).toHaveProperty('sid');
    expect(handshake).toHaveProperty('pingInterval');

    // The connection exists, but the namespace refuses it without a signed-in session (B-38, F-111).
    expect(connectError).toBe('44{"message":"unauthorized"}');
    expect(rest).toEqual([]);
    await expectNoA11yViolations(page);
  });

  test('B-07: the socket upgrade through nginx requires the allow-listed origin', async ({ baseURL }) => {
    if (!baseURL) throw new Error('baseURL is not set (E2E_BASE_URL)');
    const appOrigin = new URL(baseURL).origin;

    // Control: the same request from the app's origin is upgraded, so the refusals below are about the origin only.
    expect(await upgradeStatus(baseURL, appOrigin)).toBe(101);
    expect(await upgradeStatus(baseURL, 'https://attacker.example')).toBe(400);
    expect(await upgradeStatus(baseURL, null)).toBe(400);
  });

  test('B-134: the socket client comes only from the bundle: nginx serves no /socket.io/socket.io.js', async ({
    request,
  }) => {
    const shell = await (await request.get('/')).text();
    // The shell loads the app bundle only; no global socket.io script tag (legacy loaded both).
    expect(shellAssetPaths(shell).filter((path) => path.startsWith('/socket.io'))).toEqual([]);

    for (const path of ['/socket.io/socket.io.js', '/socket.io/socket.io.min.js']) {
      await test.step(path, async () => {
        const response = await request.get(path);
        // engine.io answers anything below its path that is not a WebSocket handshake (serveClient is off).
        expect(response.status(), path).toBe(400);
        expect(response.headers()['content-type'], path).toMatch(/^application\/json/);
        expect(await response.text(), path).not.toMatch(/function\s*\(|=>|<html/i);
      });
    }
  });
});
