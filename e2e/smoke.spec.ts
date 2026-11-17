import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import { expectNoA11yViolations } from './a11y.js';
import { expect, test } from './fixtures/test.js';

/**
 * Stack smoke test (Phase 1a, extended in 1c): the production images are up behind nginx (scripts/run-e2e.mjs starts
 * them), the SPA shell and the welcome page load under the strict CSP from apps/web/nginx.conf, and the socket path
 * through nginx upgrades and then rejects an anonymous client. Every test fails on a CSP console message through the
 * shared fixture (`e2e/fixtures/test.ts`). Phase 5 removes this file only once its checks are covered elsewhere; the
 * raw-socket checks (B-07, B-38) then move into routing.spec.ts.
 */

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

test.describe('stack smoke', () => {
  test('the API is ready behind nginx', async ({ request }) => {
    const response = await request.get('/health/ready');

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('/ serves the SPA shell with lang="en" and a strict CSP', async ({ request }) => {
    const response = await request.get('/');

    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers['content-type']).toContain('text/html');
    // The policy must exist and must not allow inline scripts (B-107), otherwise the console check proves nothing.
    // connect-src 'self' is what lets the same-origin WebSocket below through (ADR-0019 §6).
    expect(headers['content-security-policy']).toContain("script-src 'self'");
    expect(headers['content-security-policy']).toContain("connect-src 'self'");
    expect(headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(await response.text()).toMatch(/<html lang="en">/);
  });

  test('the page renders without CSP violations or uncaught errors', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    const response = await page.goto('/');

    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // React rendered a page, so the module script and the stylesheet were allowed to load.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Fonts load lazily once text uses them; wait until they settle so a blocked font-src is already reported to the
    // fixture's CSP check before the test ends.
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });

  test('a visitor sees the welcome page, axe clean in light and dark mode', async ({ page }) => {
    // The guard's `GET /api/me` must answer 401 (a visitor, ADR-0013). Any other answer sends the page to
    // RouteErrorPage, which also has a level-1 heading in `main`, so the heading alone would not prove the welcome page.
    const meResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/me' && response.request().method() === 'GET',
    );
    await page.goto('/welcome');
    expect((await meResponse).status()).toBe(401);

    // A visitor stays on /welcome (redirectIfAuthenticated only redirects a signed-in user, ADR-0013).
    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0);
    await expectNoA11yViolations(page);

    await page.emulateMedia({ colorScheme: 'dark' });
    // The dark token set is active (tokens.css sets `color-scheme: dark` with it), so axe checks the dark contrasts.
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
    await expectNoA11yViolations(page);
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
  });

  test('B-07: the socket upgrade through nginx requires the allow-listed origin', async ({ baseURL }) => {
    if (!baseURL) throw new Error('baseURL is not set (E2E_BASE_URL)');
    const appOrigin = new URL(baseURL).origin;

    // Control: the same request from the app's origin is upgraded, so the refusals below are about the origin only.
    expect(await upgradeStatus(baseURL, appOrigin)).toBe(101);
    expect(await upgradeStatus(baseURL, 'https://attacker.example')).toBe(400);
    expect(await upgradeStatus(baseURL, null)).toBe(400);
  });
});
