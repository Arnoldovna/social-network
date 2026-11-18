import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';

import { composeValue } from '../scripts/dev-setup.mjs';
import { DEMO_EMAIL, parseEnv } from '../scripts/setup-env.mjs';
import { mainNav, pageHeading, wholeName } from './fixtures/ui.js';

/**
 * README media (portfolio-readme skill), run by `pnpm media:readme` against the seeded `pnpm demo` stack, never by
 * `pnpm test:e2e` (playwright.config.ts ignores this file). Writes the three README screenshots to `docs/media/` and
 * `docs/media/raw/main-flow.webm` (only when the whole flow passed). The clip writes one post on Tomás's wall and
 * deletes it again, so the demo data ends as it started; an interrupted run deletes it afterwards. Convert the clip
 * for the README with
 *
 *   ffmpeg -i docs/media/raw/main-flow.webm -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" -loop 0 docs/media/main-flow.gif
 *
 * and keep every PNG under 1 MB and the GIF under 3 MB. `docs/media/raw/` is git-ignored.
 *
 * This is the one place that logs in as the seeded demo account (the e2e specs never do, ADR-0016). Only the demo
 * password is read, the way `pnpm demo` resolves it (process environment, else `.env`); it is never printed, and no
 * other secret from `.env` reaches the Playwright process.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs', 'media');
const RAW = path.join(OUT, 'raw');
const FLOW_FRIEND = { firstName: 'Tomás', fullName: 'Tomás Ferreira' } as const;
const FLOW_POST = 'Saving you a seat at board games on Thursday.';

const DESKTOP = { width: 1440, height: 900 } as const;
const MOBILE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** SEED_DEMO_PASSWORD as `pnpm demo` seeded and printed it: a process variable wins over `.env` (composeValue). */
function demoPassword(): string {
  let dotenv: Map<string, string>;
  try {
    dotenv = parseEnv(readFileSync(path.join(ROOT, '.env'), 'utf8'));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    dotenv = new Map();
  }
  const password = composeValue('SEED_DEMO_PASSWORD', process.env, dotenv);
  if (!password) throw new Error('SEED_DEMO_PASSWORD is not set: run `pnpm demo` first, then `pnpm media:readme`.');
  return password;
}

/**
 * Ready for a screenshot: the expected page is shown (its level-1 heading, after a client-side navigation the only
 * proof that the previous page is gone), nothing is loading, no error is shown, the fonts are in and every image in
 * the document is decoded. AppLayout's `<main>` is visible long before a page has its data, so it is no signal.
 */
async function settle(page: Page, heading?: string): Promise<void> {
  await expect(heading === undefined ? page.getByRole('main') : pageHeading(page, heading)).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /^loading/ })).toHaveCount(0);
  // Toast keeps an empty `role="alert"` region mounted; only an alert with text is an error on screen.
  await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const images = Array.from(document.images);
        if (!images.every((image) => image.complete && image.naturalWidth > 0)) return false;
        await Promise.all(images.map((image) => image.decode()));
        return true;
      }),
    )
    .toBe(true);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** A visible pause in the recorded clip; video timing is the one place where waiting is the point. */
function hold(page: Page, ms: number): Promise<void> {
  return page.waitForTimeout(ms);
}

async function logIn(page: Page, { typeSlowly }: { typeSlowly: boolean }): Promise<void> {
  const password = demoPassword();
  await page.goto('/welcome/login');
  await settle(page, 'Log in');
  const emailField = page.getByLabel('email');
  const passwordField = page.getByLabel('password', { exact: true });
  if (typeSlowly) {
    await emailField.pressSequentially(DEMO_EMAIL, { delay: 25 });
    await passwordField.pressSequentially(password, { delay: 10 });
  } else {
    await emailField.fill(DEMO_EMAIL);
    await passwordField.fill(password);
  }
  await page.getByRole('button', { name: wholeName('log in') }).click();
  await expect(page).not.toHaveURL(/\/welcome/);
  await expect(pageHeading(page, 'Log in')).toHaveCount(0);
  await settle(page);
}

let session: StorageState | undefined;

/** One login for all screenshots: production allows 10 auth requests per 15 minutes and IP (ADR-0006). */
async function sessionState(browser: Browser): Promise<StorageState> {
  if (session) return session;
  const context = await browser.newContext();
  try {
    await logIn(await context.newPage(), { typeSlowly: false });
    session = await context.storageState();
    return session;
  } finally {
    await context.close();
  }
}

async function shoot(
  browser: Browser,
  { file, url, heading }: { file: string; url: string; heading?: string },
  options: BrowserContextOptions,
): Promise<void> {
  const storageState = await sessionState(browser);
  const context = await browser.newContext({ reducedMotion: 'reduce', storageState, ...options });
  try {
    const page = await context.newPage();
    await page.goto(url);
    await settle(page, heading);
    await page.screenshot({ path: path.join(OUT, file) });
  } finally {
    await context.close();
  }
}

function flowPosts(page: Page): Locator {
  return page.getByRole('article').filter({ hasText: FLOW_POST });
}

/** Deletes `post` through its confirm dialog; `beforeConfirm` runs while the dialog is open (a pause in the clip). */
async function deletePost(
  page: Page,
  post: Locator,
  { beforeConfirm }: { beforeConfirm?: () => Promise<void> } = {},
): Promise<void> {
  await post.getByRole('button', { name: /^delete post/i }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await beforeConfirm?.();
  await dialog.getByRole('button', { name: 'delete post', exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Deletes what an interrupted recording left on the friend's wall, outside the recording. */
async function removeLeftoverPosts(browser: Browser, storageState: StorageState, wallUrl: string): Promise<void> {
  const context = await browser.newContext({ viewport: DESKTOP, storageState });
  try {
    const page = await context.newPage();
    await page.goto(wallUrl);
    await settle(page, FLOW_FRIEND.fullName);
    const leftover = flowPosts(page);
    for (let count = await leftover.count(); count > 0; count = await leftover.count()) {
      await deletePost(page, leftover.first());
      await expect(leftover).toHaveCount(count - 1);
    }
  } finally {
    await context.close();
  }
}

/** Throws nothing, the one failure as it is, or all of them together, so no failure hides another. */
function throwFailures(failures: readonly unknown[]): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(
    failures,
    failures.map((failure) => (failure instanceof Error ? failure.message : String(failure))).join('\n\n'),
  );
}

/** Runs every step even when an earlier one failed and returns the failures. */
async function runEach(steps: readonly (() => Promise<void>)[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/**
 * The recorded journey. `onWall` receives the friend's wall path before anything is written there, so an interrupted
 * run can still remove its post.
 */
async function recordMainFlow(page: Page, onWall: (wallUrl: string) => void): Promise<void> {
  await logIn(page, { typeSlowly: true });
  await hold(page, 700);
  await mainNav(page)
    .getByRole('link', { name: /^friends/i })
    .click();
  await settle(page, 'Friends');
  await hold(page, 900);
  await page.getByRole('main').getByRole('link', { name: FLOW_FRIEND.fullName }).first().click();
  // /users/:id runs a loader (redirectIfOwnProfile) while the friends page stays on screen: wait for the profile.
  await expect(page).toHaveURL(/\/users\/\d+$/);
  await settle(page, FLOW_FRIEND.fullName);
  onWall(new URL(page.url()).pathname);
  // The wall has loaded (settle), so an empty match means no post from an earlier run is left.
  await expect(flowPosts(page), 'a previous run left the flow post behind').toHaveCount(0);
  await hold(page, 600);
  await page
    .getByRole('textbox', { name: `write on ${FLOW_FRIEND.firstName}'s wall`, exact: true })
    .pressSequentially(FLOW_POST, { delay: 30 });
  await page.getByRole('button', { name: wholeName('post') }).click();
  const post = flowPosts(page);
  await expect(post).toBeVisible();
  await hold(page, 400);
  await page.mouse.wheel(0, 260);
  await hold(page, 1400);
  await deletePost(page, post, { beforeConfirm: () => hold(page, 1000) });
  await expect(post).toHaveCount(0);
  await hold(page, 1200);
}

test.beforeAll(async () => {
  await mkdir(RAW, { recursive: true });
});

test('desktop light: friends', async ({ browser }) => {
  await shoot(
    browser,
    { file: 'desktop-light.png', url: '/friends', heading: 'Friends' },
    { viewport: DESKTOP, colorScheme: 'light' },
  );
});

test('desktop dark: chat', async ({ browser }) => {
  await shoot(
    browser,
    { file: 'desktop-dark.png', url: '/chat', heading: 'Chat' },
    { viewport: DESKTOP, colorScheme: 'dark' },
  );
});

test('mobile light: own profile', async ({ browser }) => {
  await shoot(browser, { file: 'mobile-light.png', url: '/' }, { ...MOBILE, colorScheme: 'light' });
});

// Main flow: log in, open a friend from the friends list, write on their wall, delete the post again through the
// confirm dialog. The recording logs in on its own, so the clip shows the login form.
test('main flow clip', async ({ browser }) => {
  test.setTimeout(120_000);
  const viewport = { width: 1280, height: 960 };
  const videoDir = path.join(RAW, 'video');
  const context = await browser.newContext({
    viewport,
    colorScheme: 'light',
    recordVideo: { dir: videoDir, size: viewport },
  });
  const page = await context.newPage();
  const video = page.video();
  let wallUrl: string | undefined;
  const failures = await runEach([
    () =>
      recordMainFlow(page, (url) => {
        wallUrl = url;
      }),
  ]);
  const flowPassed = failures.length === 0;
  let storageState: StorageState | undefined;
  // Each step runs even when an earlier one failed: a failed post clean-up must not leave raw/video/ behind.
  const cleanupFailures = await runEach([
    async () => {
      storageState = await context.storageState();
    },
    () => context.close(), // finishes the video file
    async () => {
      if (!flowPassed && wallUrl !== undefined && storageState !== undefined) {
        await removeLeftoverPosts(browser, storageState, wallUrl);
      }
    },
    async () => {
      // A partial recording never replaces the last good clip.
      if (flowPassed) await video?.saveAs(path.join(RAW, 'main-flow.webm'));
    },
    () => rm(videoDir, { recursive: true, force: true }),
  ]);
  throwFailures([...failures, ...cleanupFailures]);
});
