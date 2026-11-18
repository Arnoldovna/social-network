import { randomUUID } from 'node:crypto';

import type { Locator, Page, Request } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothSchemes } from './a11y.js';
import { expect, test, type E2EUser } from './fixtures/test.js';
import { fullName, headerMenuButton, openHeaderPanelIfCollapsed, usesHeaderPanel, wholeName } from './fixtures/ui.js';

/**
 * The "find people" search in the header (FEATURES §8; BUILD-ORDER Phase 5 "friends + search"): a labelled,
 * debounced WAI-ARIA combobox whose listbox links to profiles (F-59, F-62), with a sentence when nothing matches
 * (F-63). The people a test searches for share a last-name prefix no other test uses, so the expected results are
 * exactly the test's own people, whatever else is in the shared e2e database.
 */

/** `DEFAULT_DEBOUNCE_MS` in apps/web/src/shared/lib/use-debounced-value.ts (F-59: "debounced ~300 ms"). */
const SEARCH_DEBOUNCE_MS = 300;

/** `SEARCH_LIMIT_DEFAULT` in packages/shared: the header asks for ten results (F-61). */
const SEARCH_LIMIT_DEFAULT = 10;

const SEARCH_PATH = '/api/users/search';

/** A last-name prefix that only this test's people carry, e.g. "Qz3fa1b2c4d5". */
function uniquePrefix(): string {
  return `Qz${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

interface SearchWidget {
  combobox: Locator;
  listbox: Locator;
  options: Locator;
  /** The polite live region of the popup: "searching…", the count, the no-match sentence or the error. */
  status: Locator;
}

function searchWidget(page: Page): SearchWidget {
  const form = page.getByRole('banner').getByRole('search');
  const listbox = form.getByRole('listbox', { name: wholeName('find people') });
  return {
    combobox: form.getByRole('combobox', { name: wholeName('find people') }),
    listbox,
    options: listbox.getByRole('option'),
    status: form.getByRole('status'),
  };
}

/** Opens the own profile as the start page and waits until the app shell (with the header search) is there. */
async function openApp(page: Page, me: E2EUser): Promise<SearchWidget> {
  await page.goto('/');
  await expect(page.getByRole('main').getByRole('heading', { level: 1, name: fullName(me) })).toBeVisible();
  await openHeaderPanelIfCollapsed(page);
  const widget = searchWidget(page);
  await expect(widget.combobox).toBeVisible();
  return widget;
}

/** Records every `GET /api/users/search` the page sends from now on. */
function recordSearches(page: Page): Request[] {
  const searches: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === SEARCH_PATH) searches.push(request);
  });
  return searches;
}

function searchParams(request: Request): { q: string | null; limit: string | null } {
  const { searchParams: params } = new URL(request.url());
  return { q: params.get('q'), limit: params.get('limit') };
}

/** The listbox shows exactly these people, in this order (F-61: ordered by name). */
async function expectResults(widget: SearchWidget, people: readonly E2EUser[]): Promise<void> {
  await expect(widget.listbox).toBeVisible();
  await expect(widget.options).toHaveCount(people.length);
  for (const [index, person] of people.entries()) {
    await expect(widget.options.nth(index)).toHaveAccessibleName(fullName(person));
  }
}

/** `person` is the active option: selected, announced through `aria-activedescendant`, focus still in the input. */
async function expectActiveOption(widget: SearchWidget, person: E2EUser): Promise<void> {
  const option = widget.listbox.getByRole('option', { name: fullName(person), selected: true });
  await expect(option).toBeVisible();
  await expect(widget.listbox.getByRole('option', { selected: true })).toHaveCount(1);
  const optionId = await option.getAttribute('id');
  if (optionId === null) throw new Error(`The option for ${fullName(person)} has no id.`);
  await expect(widget.combobox).toHaveAttribute('aria-activedescendant', optionId);
  await expect(widget.combobox).toBeFocused();
}

async function expectClosed(widget: SearchWidget): Promise<void> {
  await expect(widget.listbox).toBeHidden();
  await expect(widget.options).toHaveCount(0);
}

test.describe('find people', () => {
  test('F-59: the labelled field searches 300 ms after the last keystroke, with one request per pause', async ({
    createUser,
    pageAs,
  }) => {
    const prefix = uniquePrefix();
    const me = await createUser({ firstName: 'Mara' });
    const alma = await createUser({ firstName: 'Alma', lastName: `${prefix}-one` });
    const page = await pageAs(me);
    // Fake timers drive the debounce. The clock flows normally until the test pauses it, and it must flow again
    // before the answer can render: the store batches its notifications to the UI on a timer as well.
    await page.clock.install();
    const widget = await openApp(page, me);
    const searches = recordSearches(page);
    await page.clock.pauseAt(Date.now() + 1000);

    // Several keystrokes while the clock stands still: the popup says "searching…", but nothing is sent yet.
    await widget.combobox.pressSequentially(prefix.toLowerCase());
    await expect(widget.status).toHaveText('searching…');
    await expect(widget.listbox).toBeHidden();
    expect(searches).toHaveLength(0);

    // 300 ms after the last keystroke exactly one request goes out, for the whole term.
    await page.clock.runFor(SEARCH_DEBOUNCE_MS);
    await expect
      .poll(() => searches.map(searchParams))
      .toEqual([{ q: prefix.toLowerCase(), limit: String(SEARCH_LIMIT_DEFAULT) }]);

    await page.clock.resume();
    await expectResults(widget, [alma]);
    await expect(widget.combobox).toHaveAttribute('aria-expanded', 'true');
    expect(searches).toHaveLength(1);

    await expectNoA11yViolations(page);
  });

  test('F-59: Enter searches at once, without waiting for the debounce', async ({ createUser, pageAs }) => {
    const prefix = uniquePrefix();
    const me = await createUser({ firstName: 'Mara' });
    const bruno = await createUser({ firstName: 'Bruno', lastName: `${prefix}-two` });
    const page = await pageAs(me);
    await page.clock.install();
    const widget = await openApp(page, me);
    const searches = recordSearches(page);
    await page.clock.pauseAt(Date.now() + 1000);

    await widget.combobox.fill(prefix);
    await widget.combobox.press('Enter');
    // The clock has not moved, so the debounce timer cannot have fired: only Enter can have started this search.
    await expect.poll(() => searches.map(searchParams)).toEqual([{ q: prefix, limit: String(SEARCH_LIMIT_DEFAULT) }]);

    await page.clock.resume();
    await expectResults(widget, [bruno]);
    // The debounce that ends later asks for the same term, which the cache already answers.
    expect(searches).toHaveLength(1);

    await expectNoA11yViolations(page);
  });

  test('F-62, B-94: arrow keys move through the results and Enter opens the active profile', async ({
    createUser,
    pageAs,
  }) => {
    const prefix = uniquePrefix();
    const me = await createUser({ firstName: 'Mara' });
    // Created out of order: the list is ordered by name, not by id.
    const cleo = await createUser({ firstName: 'Cleo', lastName: `${prefix}-c` });
    const alma = await createUser({ firstName: 'Alma', lastName: `${prefix}-a` });
    const bruno = await createUser({ firstName: 'Bruno', lastName: `${prefix}-b` });
    const page = await pageAs(me);
    const widget = await openApp(page, me);

    await widget.combobox.fill(prefix);
    await expectResults(widget, [alma, bruno, cleo]);
    await expect(widget.combobox).toHaveAttribute('aria-expanded', 'true');
    await expect(widget.combobox).toHaveAttribute('aria-controls', (await widget.listbox.getAttribute('id')) ?? '');

    await widget.combobox.press('ArrowDown');
    await expectActiveOption(widget, alma);
    await widget.combobox.press('ArrowDown');
    await expectActiveOption(widget, bruno);
    await widget.combobox.press('ArrowUp');
    await expectActiveOption(widget, alma);
    // Both ends wrap around.
    await widget.combobox.press('ArrowUp');
    await expectActiveOption(widget, cleo);
    await widget.combobox.press('ArrowDown');
    await expectActiveOption(widget, alma);
    await widget.combobox.press('ArrowUp');
    await expectActiveOption(widget, cleo);
    await expectNoA11yViolationsInBothSchemes(page);

    await widget.combobox.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/users/${String(cleo.id)}$`));
    await expect(page.getByRole('main').getByRole('heading', { level: 1, name: fullName(cleo) })).toBeVisible();
    await expectClosed(widget);

    await expectNoA11yViolations(page);
  });

  test('F-62, B-94: Escape and a click outside close the results', async ({ createUser, pageAs }) => {
    const prefix = uniquePrefix();
    const me = await createUser({ firstName: 'Mara' });
    const alma = await createUser({ firstName: 'Alma', lastName: `${prefix}-a` });
    const page = await pageAs(me);
    const widget = await openApp(page, me);

    await widget.combobox.fill(prefix);
    await expectResults(widget, [alma]);

    // Escape closes the list only: the term and the focus stay in the field.
    await widget.combobox.press('Escape');
    await expectClosed(widget);
    await expect(widget.combobox).toHaveAttribute('aria-expanded', 'false');
    await expect(widget.combobox).toHaveValue(prefix);
    await expect(widget.combobox).toBeFocused();
    if (usesHeaderPanel(page)) {
      // In the "menu" panel the first Escape belonged to the list; the next one closes the panel (F-94).
      await expect(headerMenuButton(page)).toHaveAttribute('aria-expanded', 'true');
      await widget.combobox.press('Escape');
      await expect(headerMenuButton(page)).toHaveAttribute('aria-expanded', 'false');
      await expect(headerMenuButton(page)).toBeFocused();
      await openHeaderPanelIfCollapsed(page);
    }

    // ArrowDown opens the list again on the first result.
    await widget.combobox.press('ArrowDown');
    await expectActiveOption(widget, alma);

    // A click anywhere outside the search closes it as well.
    await page.getByRole('main').click({ position: { x: 8, y: 8 } });
    await expectClosed(widget);
    await expect(widget.combobox).toHaveAttribute('aria-expanded', 'false');
    await expect(page).toHaveURL(/\/$/);

    await expectNoA11yViolations(page);
  });

  test('F-62, B-93: every result is a link to the profile, and a click opens it', async ({ createUser, pageAs }) => {
    const prefix = uniquePrefix();
    const me = await createUser({ firstName: 'Mara' });
    const alma = await createUser({ firstName: 'Alma', lastName: `${prefix}-a` });
    const bruno = await createUser({ firstName: 'Bruno', lastName: `${prefix}-b` });
    const page = await pageAs(me);
    const widget = await openApp(page, me);

    await widget.combobox.fill(prefix);
    await expectResults(widget, [alma, bruno]);
    for (const person of [alma, bruno]) {
      await expect(widget.listbox.getByRole('option', { name: fullName(person) })).toHaveAttribute(
        'href',
        `/users/${String(person.id)}`,
      );
    }

    await widget.listbox.getByRole('option', { name: fullName(bruno) }).click();
    await expect(page).toHaveURL(new RegExp(`/users/${String(bruno.id)}$`));
    await expect(page.getByRole('main').getByRole('heading', { level: 1, name: fullName(bruno) })).toBeVisible();
    await expectClosed(widget);

    await expectNoA11yViolations(page);
  });

  test('F-63, B-49: no match shows a sentence instead of an empty or broken list', async ({ createUser, pageAs }) => {
    const prefix = uniquePrefix();
    const me = await createUser({ firstName: 'Mara' });
    const alma = await createUser({ firstName: 'Alma', lastName: `${prefix}-a` });
    const page = await pageAs(me);
    const widget = await openApp(page, me);
    const nobody = `${prefix}-nobody`;

    await widget.combobox.fill(nobody);
    await widget.combobox.press('Enter');
    await expect(widget.status).toHaveText(`No people found for "${nobody}".`);
    await expect(page.getByRole('search').getByText('Try the beginning of a first or last name.')).toBeVisible();
    await expectClosed(widget);
    await expect(widget.combobox).toHaveAttribute('aria-expanded', 'false');
    await expectNoA11yViolationsInBothSchemes(page);

    // The app keeps working: the next search finds the person.
    await widget.combobox.fill(prefix);
    await expectResults(widget, [alma]);
    await expect(page.getByRole('search').getByText('Try the beginning of a first or last name.')).toBeHidden();

    await expectNoA11yViolations(page);
  });

  test('B-49: every match is listed in name order, never only the first and never the searcher', async ({
    createUser,
    pageAs,
  }) => {
    const prefix = uniquePrefix();
    // The searcher carries the prefix too, and must not find themselves.
    const me = await createUser({ firstName: 'Mara', lastName: `${prefix}-me` });
    const dina = await createUser({ firstName: 'Dina', lastName: `${prefix}-d` });
    const bruno = await createUser({ firstName: 'Bruno', lastName: `${prefix}-b` });
    const alma = await createUser({ firstName: 'Alma', lastName: `${prefix}-a` });
    const cleo = await createUser({ firstName: 'Cleo', lastName: `${prefix}-c` });
    const page = await pageAs(me);
    const widget = await openApp(page, me);

    await widget.combobox.fill(prefix);
    await expectResults(widget, [alma, bruno, cleo, dina]);
    await expect(widget.status).toHaveText('4 people found.');
    await expect(widget.listbox.getByRole('option', { name: fullName(me) })).toHaveCount(0);

    await expectNoA11yViolationsInBothSchemes(page);
  });
});
