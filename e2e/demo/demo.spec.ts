import { expect, test, type Page } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothSchemes } from '../a11y.js';
import { mainNav, openHeaderPanelIfCollapsed, pageHeading } from '../fixtures/ui.js';

/**
 * Smoke test of the GitHub Pages demo (ADR-0020) against the built demo under `vite preview`: the real app, the API
 * answered by msw in the browser, data in IndexedDB, chat and presence through the mocked Socket.IO server with
 * simulated people. Each test has its own browser context, so its own IndexedDB and service worker.
 */

const DEMO_EMAIL = 'mira.novak@example.com';
const DEMO_PASSWORD = 'lets-chat-demo';

function banner(page: Page) {
  return page.getByRole('region', { name: 'demo' });
}

/** Opens a main navigation link, through the "menu" panel below 640 px. */
async function navigate(page: Page, label: string): Promise<void> {
  await openHeaderPanelIfCollapsed(page);
  await mainNav(page).getByRole('link', { name: label, exact: true }).click();
}

async function logInAsMira(page: Page): Promise<void> {
  await page.goto('welcome/login');
  await page.getByRole('textbox', { name: 'email' }).fill(DEMO_EMAIL);
  await page.getByLabel('password', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(pageHeading(page, 'Mira Novak')).toBeVisible();
}

test('the demo starts on the welcome page with the banner and the demo login, axe clean', async ({ page }) => {
  await page.goto('');

  await expect(page).toHaveURL(/\/social-network\/welcome$/);
  await expect(banner(page)).toContainText('Demo – Daten bleiben nur in deinem Browser');
  await expect(banner(page)).toContainText(DEMO_EMAIL);
  await expect(banner(page)).toContainText(DEMO_PASSWORD);
  await expect(pageHeading(page, 'Sign up')).toBeVisible();
  await expectNoA11yViolationsInBothSchemes(page);
});

test('the seeded demo works over msw: login, wall post, persistence across a reload, reset', async ({ page }) => {
  await logInAsMira(page);
  const wall = page.getByRole('main');
  await expect(wall.getByText('Planning a small print exhibition in the stairwell.', { exact: false })).toBeVisible();

  const post = `Posted in the demo ${String(Date.now())}`;
  await wall.getByRole('textbox', { name: /write on/i }).fill(post);
  await wall.getByRole('button', { name: 'post', exact: true }).click();
  await expect(wall.getByText(post)).toBeVisible();
  await expectNoA11yViolations(page);

  // IndexedDB keeps the post and the session.
  await page.reload();
  await expect(pageHeading(page, 'Mira Novak')).toBeVisible();
  await expect(page.getByRole('main').getByText(post)).toBeVisible();

  // "reset demo data", after a confirmation: everything back to the seed, nobody signed in.
  await banner(page).getByRole('button', { name: 'reset demo data' }).click();
  const confirmation = page.getByRole('alertdialog', { name: 'Reset the demo?' });
  await expect(confirmation).toBeVisible();
  await expectNoA11yViolations(page);
  await confirmation.getByRole('button', { name: 'reset demo data' }).click();
  await expect(pageHeading(page, 'Sign up')).toBeVisible();
  await logInAsMira(page);
  await expect(
    page.getByRole('main').getByText('Planning a small print exhibition in the stairwell.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('main').getByText(post)).toHaveCount(0);
});

test('chat and presence run over the mocked socket, with simulated people who answer', async ({ page }) => {
  await logInAsMira(page);

  await navigate(page, 'online');
  await expect(pageHeading(page, /online/i)).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: 'Tomás Ferreira' })).toBeVisible();

  await navigate(page, 'chat');
  const log = page.getByRole('log', { name: 'Chat messages' });
  await expect(log.getByText('Board games on Thursday as always. New people welcome.')).toBeVisible();

  // ADR-0015: resting at the newest message, the log's top edge falls between two rows, never through one.
  const straddling = await log.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    return [...element.querySelectorAll('li')].filter((row) => {
      const box = row.getBoundingClientRect();
      return box.top < top - 1 && box.bottom > top + 1;
    }).length;
  });
  expect(straddling).toBe(0);

  const message = `Hello from the demo ${String(Date.now())}`;
  const field = page.getByRole('textbox', { name: 'message', exact: true });
  await field.fill(message);
  await field.press('Enter');
  // Acknowledged by the mocked server: the row shows its time.
  await expect(log.getByRole('listitem').filter({ hasText: message }).locator('time')).toBeVisible();

  // Someone online answers a few seconds later (simulation.ts: 2.5 to 6 s).
  const rows = log.getByRole('listitem');
  await expect(rows.last()).not.toContainText(message, { timeout: 15_000 });
  await expect(rows.last().locator('time')).toBeVisible();
  await expectNoA11yViolations(page);
});

test('a deep link loads the app under the Pages base path', async ({ page }) => {
  await page.goto('chat');

  // Not signed in: the guard sends the visitor to the welcome page, inside the base path.
  await expect(page).toHaveURL(/\/social-network\/welcome$/);
  await expect(banner(page)).toBeVisible();
});
