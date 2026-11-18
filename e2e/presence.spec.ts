import type { Locator, Page } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInDarkMode } from './a11y.js';
import { socketHandshake } from './fixtures/socket.js';
import { expect, test, type E2EUser } from './fixtures/test.js';
import { fullName } from './fixtures/ui.js';

/**
 * The online list (FEATURES §11) with several real browsers against the e2e stack. Other tests are online at the same
 * time (ADR-0016), so assertions only look at this test's own users, found by their unique last names, never at the
 * size of the list or at its empty state.
 *
 * Departures are announced only after the presence grace period (`PRESENCE_GRACE_MS`, 5 s in the e2e stack, F-87).
 * Where a test must prove that something did *not* happen after a tab closed, it closes a sentinel user's only tab at
 * the same moment and waits for the sentinel to disappear: by then the grace period of the first close has passed
 * too, and the server sends presence events in order, so a wrong `presence:left` would already have arrived.
 */

/** `PRESENCE_GRACE_MS` of the e2e stack (docker-compose.yml default, not overridden in docker-compose.e2e.yml). */
const PRESENCE_GRACE_MS = 5_000;

/** A departure shows up after the grace period plus the event's way to the other browser. */
const DEPARTURE_TIMEOUT_MS = PRESENCE_GRACE_MS + 5_000;

/** The online list's rows of `user` on `/online` (0 or 1, never more). */
function onlineRow(page: Page, user: E2EUser): Locator {
  return page
    .getByRole('list', { name: 'Online' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: fullName(user), exact: true }) });
}

/** Any link to `user` in the page's main area, whether the list is shown or the empty state. */
function linksTo(page: Page, user: E2EUser): Locator {
  return page.getByRole('main').getByRole('link', { name: fullName(user), exact: true });
}

/** Navigates to `path` and waits until the page's socket is connected, i.e. the user is online. */
async function goOnline(page: Page, path: string): Promise<void> {
  const connected = socketHandshake(page);
  await page.goto(path);
  await connected;
}

/** Opens `/online` connected, with the list (or its empty state) loaded. */
async function openOnlineList(page: Page): Promise<void> {
  await goOnline(page, '/online');
  await expect(page.getByRole('heading', { level: 1, name: 'Online' })).toBeVisible();
  await expect(page.getByText('loading who is online…')).toHaveCount(0);
}

/**
 * Counts, from now on, how often a link to `user` is removed from the page's main area. A reload of `user` within the
 * grace period must not make their row flicker (F-87), which a later look at the list alone could not prove.
 */
async function countRemovals(page: Page, user: E2EUser): Promise<() => Promise<number>> {
  const name = fullName(user);
  await page.evaluate((watched) => {
    const root = document.querySelector('main');
    if (root === null) throw new Error('no <main> to observe');
    document.documentElement.dataset['e2eRemovals'] = '0';
    new MutationObserver((records) => {
      const removed = records
        .flatMap((record) => Array.from(record.removedNodes))
        .filter((node) => node.textContent?.includes(watched) === true).length;
      if (removed > 0) {
        const before = Number(document.documentElement.dataset['e2eRemovals'] ?? '0');
        document.documentElement.dataset['e2eRemovals'] = String(before + removed);
      }
    }).observe(root, { childList: true, subtree: true });
  }, name);
  return () => page.evaluate(() => Number(document.documentElement.dataset['e2eRemovals'] ?? 'NaN'));
}

test.describe('online users', () => {
  test('F-86, B-46: /online lists other connected users with avatar and profile link, never the viewer', async ({
    createUser,
    pageAs,
  }) => {
    const viewer = await createUser({ firstName: 'Vera' });
    const connected = await createUser({ firstName: 'Cleo' });
    const signedOut = await createUser({ firstName: 'Otto' });
    // `signedOut` is registered and has a session, but no open page and therefore no socket.

    const connectedPage = await pageAs(connected);
    await goOnline(connectedPage, '/chat');
    const viewerPage = await pageAs(viewer);
    await openOnlineList(viewerPage);

    const row = onlineRow(viewerPage, connected);
    await expect(row).toHaveCount(1);
    await expect(row.getByRole('link', { name: fullName(connected), exact: true })).toHaveAttribute(
      'href',
      `/users/${String(connected.id)}`,
    );
    await expect(row.getByRole('img', { name: `${fullName(connected)}'s profile picture` })).toBeVisible();
    await expect(viewerPage.getByRole('status').filter({ hasText: /\bonline$/ })).toBeVisible();

    // B-46: the viewer is never in their own list; F-86: only users with an open connection are.
    await expect(linksTo(viewerPage, viewer)).toHaveCount(0);
    await expect(linksTo(viewerPage, signedOut)).toHaveCount(0);

    await expectNoA11yViolations(viewerPage);
    await expectNoA11yViolationsInDarkMode(viewerPage);

    // The name leads to the profile, inside the app.
    await row.getByRole('link', { name: fullName(connected), exact: true }).click();
    await expect(viewerPage).toHaveURL(new RegExp(`/users/${String(connected.id)}$`));
    await expect(viewerPage.getByRole('heading', { level: 1, name: fullName(connected) })).toBeVisible();
  });

  test('F-88, F-87, B-87, B-43: joins appear live once, a second tab neither duplicates nor outlives the user', async ({
    createUser,
    pageAs,
  }) => {
    const viewer = await createUser();
    const joiner = await createUser();
    const sentinel = await createUser();
    const viewerPage = await pageAs(viewer);
    await openOnlineList(viewerPage);
    await expect(linksTo(viewerPage, joiner)).toHaveCount(0);

    // F-88: someone signing in appears without a reload.
    const firstTab = await pageAs(joiner);
    await goOnline(firstTab, '/chat');
    await expect(onlineRow(viewerPage, joiner)).toHaveCount(1);

    // F-87, B-87: a second tab of the same browser (same session) is still one person. The sentinel connects after
    // it, so by the time the sentinel is listed, any presence event about the second tab has reached the viewer.
    const secondTab = await firstTab.context().newPage();
    await goOnline(secondTab, '/friends');
    const sentinelPage = await pageAs(sentinel);
    await goOnline(sentinelPage, '/chat');
    await expect(onlineRow(viewerPage, sentinel)).toHaveCount(1);
    await expect(onlineRow(viewerPage, joiner)).toHaveCount(1);

    // F-87, B-43: closing one of two tabs keeps the user online. The sentinel's only tab closes after it; once the
    // sentinel is gone, the grace period of the first close is over as well.
    await firstTab.close();
    await sentinelPage.close();
    await expect(onlineRow(viewerPage, sentinel)).toHaveCount(0, { timeout: DEPARTURE_TIMEOUT_MS });
    await expect(onlineRow(viewerPage, joiner)).toHaveCount(1);

    // Closing the last tab removes the user from the list in real time, after the grace period.
    await secondTab.close();
    await expect(linksTo(viewerPage, joiner)).toHaveCount(0, { timeout: DEPARTURE_TIMEOUT_MS });
    await expectNoA11yViolations(viewerPage);
  });

  test('F-87: a reload within the grace period does not make the user flicker in other lists', async ({
    createUser,
    pageAs,
  }) => {
    const viewer = await createUser();
    const reloader = await createUser();
    const sentinel = await createUser();

    const reloaderPage = await pageAs(reloader);
    await goOnline(reloaderPage, '/chat');
    const sentinelPage = await pageAs(sentinel);
    await goOnline(sentinelPage, '/chat');
    const viewerPage = await pageAs(viewer);
    await openOnlineList(viewerPage);
    await expect(onlineRow(viewerPage, reloader)).toHaveCount(1);
    await expect(onlineRow(viewerPage, sentinel)).toHaveCount(1);
    const removalsOfReloader = await countRemovals(viewerPage, reloader);

    // The reload closes the old socket and opens a new one; the sentinel leaves right after the old socket closed.
    const reconnected = socketHandshake(reloaderPage);
    await reloaderPage.reload();
    await reconnected;
    await sentinelPage.close();
    await expect(onlineRow(viewerPage, sentinel)).toHaveCount(0, { timeout: DEPARTURE_TIMEOUT_MS });

    // The grace period of the reload's disconnect is over: the reloader is listed and was never removed meanwhile.
    await expect(onlineRow(viewerPage, reloader)).toHaveCount(1);
    expect(await removalsOfReloader()).toBe(0);
    await expectNoA11yViolations(viewerPage);
  });
});
