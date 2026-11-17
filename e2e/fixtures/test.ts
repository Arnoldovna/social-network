import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';

import { registerUser, type E2EUser, type RegisterFields } from './api.js';

/**
 * The `test` every spec imports (ADR-0016). On top of Playwright's fixtures it
 *
 * - fails a test when any browser context it used logged a console message containing "Content Security Policy"
 *   (Chromium reports every blocked load, inline script or connection that way, e.g. "Refused to connect to … because
 *   it violates the following Content Security Policy directive: …"), so the strict nginx CSP (B-107) is checked on
 *   every journey without each spec listening for it;
 * - registers users through the real API (`createUser`, `user`) and disposes their clients afterwards;
 * - opens pages that are already signed in (`pageAs(user)`, `userPage`), each in its own browser context created from
 *   the user's `storageState`, so two users in one test are two independent browsers (real-time journeys).
 *
 * Contexts from `pageAs` inherit the project's `use` options (viewport, device, baseURL), like the built-in `context`.
 */

const CSP_CONSOLE_MARKER = 'Content Security Policy';

export interface E2EFixtures {
  /** CSP console messages of every context of this test; asserted empty when the test ends. */
  cspViolations: string[];
  /** Registers a fresh user with unique email and last name; any field can be overridden. */
  createUser: (fields?: Partial<RegisterFields>) => Promise<E2EUser>;
  /** A fresh registered user, created when a test asks for it. */
  user: E2EUser;
  /** A new page in its own context, signed in as `user` (same session as `user.api`). */
  pageAs: (user: E2EUser) => Promise<Page>;
  /** `pageAs(user)` for the common single-user journey. */
  userPage: Page;
}

function watchForCspViolations(context: BrowserContext, violations: string[]): void {
  context.on('console', (message) => {
    const text = message.text();
    if (text.includes(CSP_CONSOLE_MARKER)) {
      const { url } = message.location();
      violations.push(`[${message.type()}] ${url === '' ? (message.page()?.url() ?? 'unknown page') : url}: ${text}`);
    }
  });
}

function requireBaseURL(baseURL: string | undefined): string {
  // playwright.config.ts already refuses to start without E2E_BASE_URL; this narrows the type and guards misuse.
  if (!baseURL) throw new Error('baseURL is not set: the e2e fixtures need E2E_BASE_URL (see playwright.config.ts).');
  return baseURL;
}

export const test = base.extend<E2EFixtures>({
  cspViolations: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern as the first argument
    async ({}, use) => {
      const violations: string[] = [];
      await use(violations);
      // Every fixture that records into `violations` depends on it, so all of their contexts are closed by now.
      expect(violations, `Content Security Policy violations:\n${violations.join('\n')}`).toEqual([]);
    },
    { auto: true },
  ],

  context: async ({ context, cspViolations }, use) => {
    watchForCspViolations(context, cspViolations);
    await use(context);
  },

  createUser: async ({ baseURL }, use) => {
    const users: E2EUser[] = [];
    await use(async (fields) => {
      const user = await registerUser(requireBaseURL(baseURL), fields);
      users.push(user);
      return user;
    });
    await Promise.all(users.map((user) => user.api.dispose()));
  },

  user: async ({ createUser }, use) => {
    await use(await createUser());
  },

  pageAs: async ({ browser, cspViolations }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (user) => {
      const context = await browser.newContext({ storageState: await user.api.storageState() });
      contexts.push(context);
      watchForCspViolations(context, cspViolations);
      return context.newPage();
    });
    await Promise.all(contexts.map((context) => context.close()));
  },

  userPage: async ({ pageAs, user }, use) => {
    await use(await pageAs(user));
  },
});

export { expect };
export { befriend, logIn, requestFriendship, type E2EUser } from './api.js';
