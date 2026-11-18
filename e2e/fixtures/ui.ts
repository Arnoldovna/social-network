import { randomUUID } from 'node:crypto';

import { expect, type Locator, type Page } from '@playwright/test';

/**
 * UI helpers every journey spec needs in the same form: how the app names pages and people, the collapsed header
 * below 640 px, and proof that a navigation stayed inside one document. Feature-specific locators stay in their spec.
 */

/** The app name in every document title (`<page> · Let's chat!`, F-05). */
export const APP_NAME = "Let's chat!";

/** The header collapses search, navigation and "log out" into the "menu" panel below this width (SiteHeader.css). */
export const HEADER_PANEL_BREAKPOINT_PX = 640;

/** The document title of an app page (F-05). */
export function pageTitle(page: string): string {
  return `${page} · ${APP_NAME}`;
}

/** How the UI writes a person's name: first and last name as stored, never re-cased (F-58). */
export function fullName(user: { firstName: string; lastName: string }): string {
  return `${user.firstName} ${user.lastName}`;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The whole accessible name, any case: labels render lowercase, FEATURES "Label casing" asks for case-insensitive. */
export function wholeName(text: string): RegExp {
  return new RegExp(`^${escapeRegExp(text)}$`, 'i');
}

/** A text no other test (or parallel worker, or repeated run) writes, so it identifies this test's content. */
export function uniqueText(label: string): string {
  return `${label} ${randomUUID().slice(0, 8)}`;
}

/** The level-1 heading inside `<main>`: every page has exactly one (B-108), so it identifies the page shown. */
export function pageHeading(page: Page, name: string | RegExp): Locator {
  return page.getByRole('main').getByRole('heading', { level: 1, name, exact: typeof name === 'string' });
}

/** True below 640 px, where the header shows the "menu" button instead of search, navigation and "log out". */
export function usesHeaderPanel(page: Page): boolean {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('The project defines no viewport.');
  return viewport.width < HEADER_PANEL_BREAKPOINT_PX;
}

/** The main navigation ("profile", "friends", "online", "chat"); inside the "menu" panel below 640 px. */
export function mainNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Main' });
}

/** The header's "menu" disclosure button (only rendered below 640 px). */
export function headerMenuButton(page: Page): Locator {
  return page.getByRole('banner').getByRole('button', { name: wholeName('menu') });
}

/**
 * Opens the header's "menu" panel on narrow viewports, where search, the main navigation and "log out" live inside
 * it, and leaves an already open panel open. On wider viewports they are always visible and nothing happens. Every
 * navigation closes the panel again.
 */
export async function openHeaderPanelIfCollapsed(page: Page): Promise<void> {
  if (!usesHeaderPanel(page)) return;
  const menu = headerMenuButton(page);
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
}

const DOCUMENT_MARKER_KEY = '__e2eDocumentMarker';

/**
 * Stores a random value on `window` and returns it. A full page load creates a new `window` and loses it, so finding
 * the same value later (`expectSameDocument`) proves that every navigation in between stayed inside the one document
 * (no reload, F-03, B-79).
 */
export async function markDocument(page: Page): Promise<string> {
  const marker = randomUUID();
  await page.evaluate(
    ({ key, value }) => {
      Reflect.set(window, key, value);
    },
    { key: DOCUMENT_MARKER_KEY, value: marker },
  );
  return marker;
}

/** The value `markDocument` stored in the current document, or null after a full page load. */
export function documentMarker(page: Page): Promise<string | null> {
  return page.evaluate((key) => {
    const value: unknown = Reflect.get(window, key);
    return typeof value === 'string' ? value : null;
  }, DOCUMENT_MARKER_KEY);
}

export async function expectSameDocument(page: Page, marker: string): Promise<void> {
  expect(await documentMarker(page), 'the page was reloaded').toBe(marker);
}

/**
 * Holds every `GET` whose path matches `pathname` (exactly, for a string) until `release()` is called, so a loading
 * state can be asserted without racing the stack. Other methods, and every request after the release, pass on.
 */
export async function holdGets(page: Page, pathname: string | RegExp): Promise<{ release: () => void }> {
  const gate = Promise.withResolvers<undefined>();
  await page.route(
    (url) => (typeof pathname === 'string' ? url.pathname === pathname : pathname.test(url.pathname)),
    async (route) => {
      if (route.request().method() === 'GET') await gate.promise;
      await route.fallback();
    },
  );
  return {
    release: () => {
      gate.resolve(undefined);
    },
  };
}
