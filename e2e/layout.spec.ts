import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expectNoA11yViolations, setColorScheme } from './a11y.js';
import {
  expectStatus,
  PROBLEM_TYPE_PREFIX,
  registerUser,
  setBio,
  uploadAvatar,
  type RegisterFields,
} from './fixtures/api.js';
import { befriend, expect, test as base, type E2EUser } from './fixtures/test.js';
import {
  fullName,
  HEADER_PANEL_BREAKPOINT_PX,
  headerMenuButton,
  holdGets,
  mainNav,
  openHeaderPanelIfCollapsed,
  usesHeaderPanel,
} from './fixtures/ui.js';

/**
 * Layout and accessibility journeys (BUILD-ORDER Phase 5 "layout + a11y"; F-58, F-92 – F-98, F-100 – F-105).
 *
 * - Header and navigation (F-92 – F-94): content, `aria-current`, the "menu" disclosure below 640 px, and the two-row
 *   header from 640 px without overflow at 640, 768 and 1024 px (ADR-0015, B-109, B-130).
 * - Welcome and about (F-95 – F-97): one or two columns, the links between the pages, no dead links (B-112).
 * - Every page from 320 to 1,920 px: no horizontal scrolling, nothing outside the viewport, no overlapping controls
 *   (F-98, B-114, B-115, B-126).
 * - Every page in light and dark mode: axe clean, one `<h1>`, a logical heading order, landmarks, the skip link first,
 *   `lang`, charset and viewport, no text below 12 px, alt text for every picture (F-100, F-101, F-103, F-104).
 * - A keyboard walk (native controls only, visible and unobscured focus) and reduced motion (F-102, F-104).
 * - Loading, error ("try again") and empty states of every data view, with a real recovery (F-105, B-82).
 *
 * Every test registers its own users through the API (ADR-0016) and asserts only on its own content, so the spec can
 * share the e2e stack with the other units. Viewports a test depends on are set explicitly, so each test means the
 * same in the desktop and the mobile project (which adds touch and mobile emulation on top).
 */

/** The overflow sweep (F-98): the smallest and largest supported widths, every breakpoint, and both project widths. */
const SWEEP_WIDTHS = [320, 390, 640, 768, 1024, 1280, 1440, 1920] as const;
/** Widths at which the two-row header is tightest (ADR-0015, B-130). */
const HEADER_WIDTHS = [640, 768, 1024] as const;
/** `--breakpoint-lg`: from here the welcome area has two columns (F-95). */
const WELCOME_TWO_COLUMNS = 1024;
const VIEWPORT_HEIGHT = 900;
const SMALL_VIEWPORT = { width: 390, height: 844 } as const;
/** Rounding of sub-pixel layout; anything beyond it is a real overflow or overlap. */
const TOLERANCE_PX = 1;
/** maw-design-system type scale minimum (`--text-micro`, F-104, B-121). */
const MIN_FONT_SIZE_PX = 12;
/** More than enough Tab presses for every page this spec walks; the walk stops as soon as focus wraps around. */
const MAX_TAB_STOPS = 150;

/** The id `IdParam` still accepts and no test user will reach: "This user does not exist." (F-42). */
const MISSING_USER_ID = 2_147_483_647;

/** One unbroken 160-character token (a pasted URL): it must wrap instead of widening the page (B-126). */
const LONG_WORD = `https://example.com/${'a'.repeat(140)}`;

const MAIN_NAV_LINKS = ['profile', 'friends', 'online', 'chat'] as const;
const NAV_PATHS: Record<(typeof MAIN_NAV_LINKS)[number], RegExp> = {
  profile: /\/$/,
  friends: /\/friends$/,
  online: /\/online$/,
  chat: /\/chat$/,
};

// ---------------------------------------------------------------------------------------------------------------------
// Test data (through the real API)
// ---------------------------------------------------------------------------------------------------------------------

interface Community {
  /** The signed-in user of the journey: a bio with a long word and a wall post with one. No avatar (initials). */
  me: E2EUser;
  /** A friend of `me` with an uploaded avatar and a mixed-case name (F-58), who wrote on `me`'s wall. */
  friend: E2EUser;
}

async function writePost(author: E2EUser, owner: E2EUser, body: string): Promise<void> {
  const step = `POST /api/users/${String(owner.id)}/posts`;
  await expectStatus(await author.api.post(`/api/users/${String(owner.id)}/posts`, { body }), 201, step);
}

type CreateUser = (fields?: Partial<RegisterFields>) => Promise<E2EUser>;

async function createCommunity(createUser: CreateUser): Promise<Community> {
  const [me, friend] = await Promise.all([
    createUser(),
    // Stored exactly like this; the UI must never re-case it (F-58, B-110).
    createUser({ firstName: 'mcKenna', lastName: `deVries-${randomUUID().slice(0, 8)}` }),
  ]);
  await befriend(friend, me);
  await Promise.all([uploadAvatar(friend), setBio(me, `Long words wrap: ${LONG_WORD}`)]);
  await writePost(friend, me, `A post with a long word: ${LONG_WORD}`);
  await writePost(me, friend, 'Hello from my side.');
  return { me, friend };
}

interface LayoutWorkerFixtures {
  /**
   * One community per worker, shared by the tests of this file that only read it. Registration is rate limited per
   * IP (`auth`: 10 per 15 minutes, x100 on the e2e stack) and every unit shares that budget, so the spec registers a
   * handful of users per run instead of two per test. No test changes these users' data, logs them out or depends on
   * what another test did with them.
   */
  workerCommunity: Community;
}

interface LayoutFixtures {
  /** The worker's community, under the name the tests use. */
  community: Community;
}

const test = base.extend<LayoutFixtures, LayoutWorkerFixtures>({
  workerCommunity: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern as the first argument
    async ({}, use, workerInfo) => {
      const { baseURL } = workerInfo.project.use;
      if (!baseURL) {
        throw new Error('baseURL is not set: the e2e fixtures need E2E_BASE_URL (see playwright.config.ts).');
      }
      const community = await createCommunity((fields) => registerUser(baseURL, fields));
      await use(community);
      await Promise.all([community.me.api.dispose(), community.friend.api.dispose()]);
    },
    { scope: 'worker' },
  ],
  community: async ({ workerCommunity }, use) => {
    await use(workerCommunity);
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------------------------------

interface PageCase {
  name: string;
  path: string;
  /** The page's one `<h1>`. */
  heading: string;
  /** Signed-in pages have the site header with the main navigation (F-92). */
  member: boolean;
}

const VISITOR_PAGES: readonly PageCase[] = [
  { name: 'sign up', path: '/welcome', heading: 'Sign up', member: false },
  { name: 'log in', path: '/welcome/login', heading: 'Log in', member: false },
  { name: 'about', path: '/welcome/about', heading: 'About', member: false },
  { name: 'not found (visitor)', path: '/no-such-page', heading: 'Page not found', member: false },
];

const MEMBER_PAGE_NAMES = [
  'own profile',
  "a friend's profile",
  'friends',
  'online',
  'chat',
  'missing user',
  'not found (member)',
] as const;
type MemberPageName = (typeof MEMBER_PAGE_NAMES)[number];

function memberPage(name: MemberPageName, { me, friend }: Community): PageCase {
  switch (name) {
    case 'own profile':
      return { name, path: '/', heading: fullName(me), member: true };
    case "a friend's profile":
      return { name, path: `/users/${String(friend.id)}`, heading: fullName(friend), member: true };
    case 'friends':
      return { name, path: '/friends', heading: 'Friends', member: true };
    case 'online':
      return { name, path: '/online', heading: 'Online', member: true };
    case 'chat':
      return { name, path: '/chat', heading: 'Chat', member: true };
    case 'missing user':
      return { name, path: `/users/${String(MISSING_USER_ID)}`, heading: 'This user does not exist.', member: true };
    case 'not found (member)':
      // Outside both layouts: no site header, even when signed in (router.tsx).
      return { name, path: '/no-such-page', heading: 'Page not found', member: false };
  }
}

/** Opens `pageCase` and waits until its heading is shown, every loading state is gone and the fonts are in. */
async function openPage(page: Page, pageCase: PageCase): Promise<void> {
  await page.goto(pageCase.path);
  await expect(page.getByRole('heading', { level: 1, name: pageCase.heading, exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /^loading/ })).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/**
 * axe once nothing is loading any more. A view that is still loading mounts its rows during the check, and their
 * fade-in (started after `expectNoA11yViolations` waited for running animations) shows axe half-transparent colours.
 */
async function expectAccessible(page: Page): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: /^loading/ })).toHaveCount(0);
  await expectNoA11yViolations(page);
}

// ---------------------------------------------------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------------------------------------------------

function banner(page: Page): Locator {
  return page.getByRole('banner');
}

function headerSearch(page: Page): Locator {
  return banner(page).getByRole('combobox', { name: 'find people' });
}

function logoutButton(page: Page): Locator {
  return banner(page).getByRole('button', { name: 'log out', exact: true });
}

function headerAvatarButton(page: Page): Locator {
  return banner(page).getByRole('button', { name: 'Change profile picture' });
}

/** Below 640 px the search, the navigation and "log out" live in the "menu" panel; this opens it (F-94). */
async function revealHeaderPanel(page: Page): Promise<void> {
  await openHeaderPanelIfCollapsed(page);
  if (usesHeaderPanel(page)) await expect(mainNav(page)).toBeVisible();
}

interface Box {
  label: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

async function boxOf(locator: Locator, label: string): Promise<Box> {
  await expect(locator, `${label} is visible`).toBeVisible();
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${label} has no layout box`);
  return { label, left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
}

function overlapping(boxes: readonly Box[]): string[] {
  const found: string[] = [];
  boxes.forEach((a, index) => {
    for (const b of boxes.slice(index + 1)) {
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (width > TOLERANCE_PX && height > TOLERANCE_PX) found.push(`${a.label} overlaps ${b.label}`);
    }
  });
  return found;
}

function outsideViewport(boxes: readonly Box[], viewportWidth: number): string[] {
  return boxes
    .filter((box) => box.left < -TOLERANCE_PX || box.right > viewportWidth + TOLERANCE_PX)
    .map((box) => `${box.label} spans ${box.left.toFixed(1)}..${box.right.toFixed(1)} of ${String(viewportWidth)} px`);
}

// ---------------------------------------------------------------------------------------------------------------------
// In-page measurements
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Everything that breaks "works from 320 to 1,920 px without horizontal scrolling or overlapping elements" (F-98):
 * the document scrolling sideways, a rendered element reaching outside the viewport (measured inside the boxes of
 * the ancestors that clip it, so a scrolled-away chat line does not count), and two controls, pictures or the
 * `<h1>` covering each other. `html`/`body` must not hide horizontal overflow, or the first check would prove nothing.
 */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ tolerance }) => {
      const problems: string[] = [];
      const root = document.documentElement;
      const viewportWidth = root.clientWidth;
      if (root.scrollWidth > viewportWidth) {
        problems.push(
          `the page scrolls sideways: ${String(root.scrollWidth)} px of content in ${String(viewportWidth)} px`,
        );
      }
      for (const element of [root, document.body]) {
        const { overflowX } = getComputedStyle(element);
        if (overflowX === 'hidden' || overflowX === 'clip') {
          problems.push(`<${element.tagName.toLowerCase()}> hides horizontal overflow (overflow-x: ${overflowX})`);
        }
      }

      const describe = (element: Element): string => {
        const className = element.getAttribute('class');
        const text = element.textContent.trim().replace(/\s+/g, ' ').slice(0, 40);
        return `<${element.tagName.toLowerCase()}${className === null ? '' : ` class="${className}"`}>${text === '' ? '' : ` "${text}"`}`;
      };

      /** The part of the element's box that can be seen: intersected with every ancestor that clips overflow. */
      const visibleRect = (element: Element): DOMRect | null => {
        const rect = element.getBoundingClientRect();
        let { left, right, top, bottom } = rect;
        for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
          if (ancestor === document.body || ancestor === root) break;
          const style = getComputedStyle(ancestor);
          if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
            const clip = ancestor.getBoundingClientRect();
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
            top = Math.max(top, clip.top);
            bottom = Math.min(bottom, clip.bottom);
          }
        }
        return right - left > 0 && bottom - top > 0 ? new DOMRect(left, top, right - left, bottom - top) : null;
      };

      const rendered = new Map<Element, DOMRect>();
      for (const element of document.body.querySelectorAll('*')) {
        // Screen-reader-only text and the off-screen skip link are 1 px boxes or translated away on purpose.
        if (element.closest('.visually-hidden, .skip-link, script, noscript') !== null) continue;
        if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const rect = visibleRect(element);
        if (rect !== null) rendered.set(element, rect);
      }

      const outside = [...rendered].filter(
        ([, rect]) => rect.left < -tolerance || rect.right > viewportWidth + tolerance,
      );
      // The outermost offender explains the rest; its descendants would only repeat it.
      for (const [element, rect] of outside.slice(0, 5)) {
        problems.push(
          `${describe(element)} reaches outside the viewport (${rect.left.toFixed(1)}..${rect.right.toFixed(1)} of ${String(viewportWidth)} px)`,
        );
      }

      const controls = [...rendered].filter(([element]) =>
        element.matches('a[href], button, input, select, textarea, img, [role="img"], h1'),
      );
      controls.forEach(([a, aRect], index) => {
        for (const [b, bRect] of controls.slice(index + 1)) {
          if (a.contains(b) || b.contains(a)) continue;
          const width = Math.min(aRect.right, bRect.right) - Math.max(aRect.left, bRect.left);
          const height = Math.min(aRect.bottom, bRect.bottom) - Math.max(aRect.top, bRect.top);
          if (width > tolerance && height > tolerance) problems.push(`${describe(a)} overlaps ${describe(b)}`);
        }
      });
      return problems;
    },
    { tolerance: TOLERANCE_PX },
  );
}

interface DocumentStructure {
  lang: string;
  charset: string | null;
  viewport: string | null;
  h1Count: number;
  h1InMain: boolean;
  headingLevels: number[];
  mainId: string | null;
  /** Text nodes rendered below the 12 px minimum (F-104). */
  smallText: string[];
  /** `<img>` without an `alt` attribute, or `role="img"` without a name (F-101). */
  unnamedImages: string[];
  /** Non-empty image names that are not "<name>'s profile picture" (the only meaningful pictures in the app). */
  imageNames: string[];
}

async function documentStructure(page: Page): Promise<DocumentStructure> {
  return page.evaluate(
    ({ minFontSize }) => {
      const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')].filter(
        (heading) =>
          heading.closest('[aria-hidden="true"]') === null && heading.checkVisibility({ visibilityProperty: true }),
      );
      const level = (heading: Element): number => {
        const ariaLevel = heading.getAttribute('aria-level');
        return ariaLevel === null ? Number(heading.tagName.slice(1)) : Number(ariaLevel);
      };
      const h1s = headings.filter((heading) => level(heading) === 1);

      const smallText: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = (node.textContent ?? '').trim();
        const parent = node.parentElement;
        if (text === '' || parent === null) continue;
        if (parent.closest('script, noscript, title') !== null) continue;
        if (!parent.checkVisibility({ visibilityProperty: true })) continue;
        const fontSize = Number.parseFloat(getComputedStyle(parent).fontSize);
        if (fontSize < minFontSize) smallText.push(`"${text.slice(0, 40)}" at ${String(fontSize)} px`);
      }

      const unnamedImages: string[] = [];
      const imageNames: string[] = [];
      for (const image of document.querySelectorAll('img')) {
        const alt = image.getAttribute('alt');
        if (alt === null) unnamedImages.push(`<img src="${image.getAttribute('src') ?? ''}"> without alt`);
        else if (alt !== '') imageNames.push(alt);
      }
      for (const image of document.querySelectorAll('[role="img"]')) {
        const label = image.getAttribute('aria-label');
        if (label === null || label.trim() === '')
          unnamedImages.push(`role="img" "${image.textContent}" without a name`);
        else imageNames.push(label);
      }

      const main = document.querySelector('main');
      return {
        lang: document.documentElement.lang,
        charset: document.characterSet,
        viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null,
        h1Count: h1s.length,
        h1InMain: h1s.length === 1 && main?.contains(h1s[0] ?? null) === true,
        headingLevels: headings.map(level),
        mainId: main?.id ?? null,
        smallText,
        unnamedImages,
        imageNames,
      };
    },
    { minFontSize: MIN_FONT_SIZE_PX },
  );
}

/** Levels never skip downwards (h1 → h3) and the first heading is the `<h1>` (F-103, B-108). */
function headingOrderProblems(levels: readonly number[]): string[] {
  const problems: string[] = [];
  if (levels[0] !== 1) problems.push(`the first heading is h${String(levels[0])}, not h1`);
  levels.forEach((current, index) => {
    const previous = levels[index - 1];
    if (previous !== undefined && current > previous + 1) {
      problems.push(`h${String(previous)} is followed by h${String(current)}`);
    }
  });
  return problems;
}

/** F-103 and F-101/F-104 for the page as it is now; the same checks run in light and dark mode. */
async function expectAccessibleStructure(page: Page, pageCase: PageCase): Promise<void> {
  const structure = await documentStructure(page);
  // B-107: language, charset and viewport come from index.html.
  expect(structure.lang).toBe('en');
  expect(structure.charset).toBe('UTF-8');
  expect(structure.viewport).toContain('width=device-width');
  // B-108: exactly one h1, inside the one main landmark, and a heading order without gaps.
  expect(structure.h1Count, `${pageCase.name}: number of h1`).toBe(1);
  expect(structure.h1InMain, `${pageCase.name}: the h1 is inside <main>`).toBe(true);
  expect(headingOrderProblems(structure.headingLevels), `heading levels ${structure.headingLevels.join(',')}`).toEqual(
    [],
  );
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('banner')).toHaveCount(1);
  // Below 640 px the navigation landmark sits in the closed "menu" panel, so it is in the DOM but not yet exposed.
  if (pageCase.member) {
    await expect(page.getByRole('navigation', { name: 'Main', includeHidden: true })).toHaveCount(1);
  }
  expect(structure.mainId, 'the skip link target').toBe('main');
  expect(structure.smallText, 'text below 12 px').toEqual([]);
  expect(structure.unnamedImages).toEqual([]);
  for (const name of structure.imageNames) expect(name).toMatch(/\S's profile picture$/);
}

interface FocusStop {
  /** Lowercased accessible text: aria-label, else the label of a form field, else the visible text. */
  name: string;
  tag: string;
  native: boolean;
  /** A 2px outline, or the 2px underline of a text field (F-102, B-106, B-123). */
  indicator: boolean;
  /** The centre of the element is on screen and the element itself is hit there (WCAG 2.4.11). */
  unobscured: boolean;
  inBanner: boolean;
  inMain: boolean;
  /** Focus went back to the document or to a stop seen before: the walk is complete. */
  wrapped: boolean;
}

/** Reads the focused element; `register` remembers it, so seeing it again later means the walk has wrapped. */
async function currentFocusStop(page: Page, register = true): Promise<FocusStop> {
  return page.evaluate((remember) => {
    const element = document.activeElement;
    const registry = window as Window & { e2eFocusStops?: WeakSet<Element> };
    registry.e2eFocusStops ??= new WeakSet();
    if (element === null || element === document.body || element === document.documentElement) {
      return {
        name: '',
        tag: 'body',
        native: false,
        indicator: false,
        unobscured: false,
        inBanner: false,
        inMain: false,
        wrapped: true,
      };
    }
    const wrapped = registry.e2eFocusStops.has(element);
    if (remember) registry.e2eFocusStops.add(element);

    const visibleText = (target: Element): string => {
      let text = '';
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.parentElement?.closest('[aria-hidden="true"]') === null) text += node.textContent ?? '';
      }
      return text;
    };
    const fieldLabel =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? [...(element.labels ?? [])].map(visibleText).join(' ')
        : '';
    const name = (element.getAttribute('aria-label') ?? (fieldLabel === '' ? visibleText(element) : fieldLabel))
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    const tag = element.tagName.toLowerCase();
    const native =
      (tag === 'a' && element.hasAttribute('href')) ||
      ['button', 'input', 'select', 'textarea', 'summary'].includes(tag);
    const style = getComputedStyle(element);
    const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2;
    const underline =
      (tag === 'input' || tag === 'textarea') &&
      style.borderBottomStyle !== 'none' &&
      Number.parseFloat(style.borderBottomWidth) >= 2;

    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const onScreen = x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
    const hit = onScreen ? document.elementFromPoint(x, y) : null;

    return {
      name,
      tag,
      native,
      indicator: outline || underline,
      unobscured: hit !== null && (hit === element || element.contains(hit)),
      inBanner: element.closest('header:not(main header)') !== null,
      inMain: element.closest('main') !== null,
      wrapped,
    };
  }, register);
}

/**
 * Presses Tab from the current focus until focus wraps around and returns every stop. Each stop is read once it has
 * scrolled into view (smooth scrolling is on without reduced motion), so "unobscured" means where the user sees it.
 */
async function tabWalk(page: Page): Promise<FocusStop[]> {
  const stops: FocusStop[] = [];
  for (let press = 0; press < MAX_TAB_STOPS; press += 1) {
    await page.keyboard.press('Tab');
    await expect
      .poll(
        async () => {
          // A probe only: it must not register the element, or the read below would count it as a wrap.
          const probe = await currentFocusStop(page, false);
          return probe.wrapped || probe.unobscured;
        },
        { message: `focus stop ${String(press + 1)} is on screen and not covered by anything` },
      )
      .toBe(true);
    const stop = await currentFocusStop(page);
    if (stop.wrapped) return stops;
    stops.push(stop);
  }
  throw new Error(`focus did not wrap around within ${String(MAX_TAB_STOPS)} Tab presses`);
}

/** Every stop of a walk is a native control with a visible, unobscured focus indicator (F-102). */
function focusProblems(stops: readonly FocusStop[]): string[] {
  return stops.flatMap((stop, index) => {
    const label = `stop ${String(index + 1)} <${stop.tag}> "${stop.name}"`;
    return [
      ...(stop.native ? [] : [`${label} is not a native link, button or form field`]),
      ...(stop.indicator ? [] : [`${label} has no visible focus indicator`]),
      ...(stop.unobscured ? [] : [`${label} is off screen or covered while focused`]),
      ...(stop.name === '' ? [`${label} has no accessible text`] : []),
    ];
  });
}

/** Elements with a running or declared animation or a non-zero transition (F-104: motion only under no-preference). */
async function movingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const moving: string[] = [];
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      const animated = style.animationName.split(',').some((name) => name.trim() !== 'none');
      const transitioned = style.transitionDuration.split(',').some((duration) => Number.parseFloat(duration) > 0);
      if (animated || transitioned) {
        moving.push(
          `<${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}"> animation ${style.animationName}, transition ${style.transitionDuration}`,
        );
      }
    }
    return moving;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// API stubs for the states of data views (F-105)
// ---------------------------------------------------------------------------------------------------------------------

/** GET requests whose path matches `pathname` answer 500 problem+json until `recover()`; then they reach the API. */
async function failApi(page: Page, pathname: RegExp): Promise<{ recover: () => void; failures: () => number }> {
  let failing = true;
  let failures = 0;
  await page.route(
    (url) => pathname.test(url.pathname),
    async (route) => {
      if (!failing || route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      failures += 1;
      await route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: `${PROBLEM_TYPE_PREFIX}internal`,
          title: 'Internal Server Error',
          status: 500,
          detail: 'An unexpected error occurred.',
          instance: new URL(route.request().url()).pathname,
        }),
      });
    },
  );
  return {
    recover: () => {
      failing = false;
    },
    failures: () => failures,
  };
}

interface DataView {
  name: string;
  path: (community: Community) => string;
  endpoint: (community: Community) => RegExp;
  loading: string;
  errorTitle: string;
  /** What the view shows once the API answers (the journey's own data). */
  loaded: (page: Page, community: Community) => Promise<void>;
}

const DATA_VIEWS: readonly DataView[] = [
  {
    name: 'own wall',
    path: () => '/',
    endpoint: ({ me }) => new RegExp(`^/api/users/${String(me.id)}/posts$`),
    loading: 'loading posts…',
    errorTitle: 'The posts could not be loaded.',
    loaded: async (page) => {
      await expect(page.getByText('A post with a long word:')).toBeVisible();
    },
  },
  {
    name: "a friend's profile",
    path: ({ friend }) => `/users/${String(friend.id)}`,
    endpoint: ({ friend }) => new RegExp(`^/api/users/${String(friend.id)}$`),
    loading: 'loading profile…',
    errorTitle: 'This profile could not be loaded.',
    loaded: async (page, { friend }) => {
      await expect(page.getByRole('heading', { level: 1, name: fullName(friend), exact: true })).toBeVisible();
      // The wall loads once the profile is there; the page is complete only with it.
      await expect(page.getByText('Hello from my side.')).toBeVisible();
    },
  },
  {
    name: "a friend's wall",
    path: ({ friend }) => `/users/${String(friend.id)}`,
    endpoint: ({ friend }) => new RegExp(`^/api/users/${String(friend.id)}/posts$`),
    loading: 'loading posts…',
    errorTitle: 'The posts could not be loaded.',
    loaded: async (page) => {
      await expect(page.getByText('Hello from my side.')).toBeVisible();
    },
  },
  {
    name: 'friends',
    path: () => '/friends',
    endpoint: () => /^\/api\/friendships$/,
    loading: 'loading friends…',
    errorTitle: 'Your friends could not be loaded.',
    loaded: async (page, { friend }) => {
      await expect(page.getByRole('main').getByRole('link', { name: fullName(friend), exact: true })).toBeVisible();
    },
  },
  {
    name: 'online',
    path: () => '/online',
    endpoint: () => /^\/api\/presence$/,
    loading: 'loading who is online…',
    errorTitle: 'The online list could not be loaded.',
    // Who else is online depends on the other specs sharing the stack; only "list or empty state" is ours to assert.
    loaded: async (page) => {
      await expect(
        page.getByRole('main').getByRole('list').or(page.getByText('Nobody else is online right now.')),
      ).toBeVisible();
    },
  },
  {
    name: 'chat',
    path: () => '/chat',
    endpoint: () => /^\/api\/chat\/messages$/,
    loading: 'loading messages…',
    errorTitle: 'The chat could not be loaded.',
    // The room is shared with the other specs: either messages or the empty state, never an error or loading.
    loaded: async (page) => {
      const history = page.getByRole('region', { name: 'Message history' });
      await expect(history.getByRole('log', { name: 'Chat messages' })).toBeVisible();
      await expect(history.getByRole('alert')).toHaveCount(0);
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// Header and navigation (F-92 – F-94)
// ---------------------------------------------------------------------------------------------------------------------

test.describe('header and navigation', () => {
  test('F-92: the header shows the logo, the search, the main navigation, the avatar and "log out"', async ({
    community,
    pageAs,
  }) => {
    const { me } = community;
    const page = await pageAs(me);
    await openPage(page, memberPage('friends', community));

    const logo = banner(page).getByRole('link', { name: "let's chat", exact: true });
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('href', '/');
    await expect(headerAvatarButton(page)).toBeVisible();

    await revealHeaderPanel(page);
    await expect(banner(page).getByRole('search')).toBeVisible();
    await expect(headerSearch(page)).toBeVisible();
    await expect(logoutButton(page)).toBeVisible();
    // Lowercase labels (maw §10) in the order profile, friends, online, chat.
    await expect(mainNav(page).getByRole('link')).toHaveText([...MAIN_NAV_LINKS]);
    await expect(banner(page).getByRole('navigation', { name: 'Main' })).toBeVisible();

    // The logo leads to the own profile without a document reload (the header stays mounted).
    await page.evaluate(() => {
      (window as Window & { e2eSamePage?: boolean }).e2eSamePage = true;
    });
    await logo.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1, name: fullName(me), exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as Window & { e2eSamePage?: boolean }).e2eSamePage)).toBe(true);

    await expectAccessible(page);
  });

  test('F-93: the current page is marked with aria-current="page", and only that one', async ({
    community,
    pageAs,
  }) => {
    const page = await pageAs(community.me);
    await openPage(page, memberPage('own profile', community));

    for (const label of MAIN_NAV_LINKS) {
      await revealHeaderPanel(page);
      await mainNav(page).getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(NAV_PATHS[label]);
      // Below 640 px every navigation closes the menu (F-94); wait for that before opening it again.
      if (usesHeaderPanel(page)) await expect(headerMenuButton(page)).toHaveAttribute('aria-expanded', 'false');
      await revealHeaderPanel(page);
      for (const other of MAIN_NAV_LINKS) {
        const link = mainNav(page).getByRole('link', { name: other, exact: true });
        if (other === label) await expect(link).toHaveAttribute('aria-current', 'page');
        else await expect(link).not.toHaveAttribute('aria-current');
      }
    }

    // Another user's profile is none of the four pages: "profile" (end-matched `/`) is not current there.
    await page.goto(`/users/${String(community.friend.id)}`);
    await expect(page.getByRole('heading', { level: 1, name: fullName(community.friend), exact: true })).toBeVisible();
    await revealHeaderPanel(page);
    await expect(mainNav(page).locator('[aria-current]')).toHaveCount(0);

    await expectAccessible(page);
  });

  test('F-94, B-109: below 640 px the navigation collapses into a working "menu" disclosure button', async ({
    community,
    pageAs,
  }) => {
    const page = await pageAs(community.me);
    await page.setViewportSize(SMALL_VIEWPORT);
    await openPage(page, { name: 'profile', path: '/', heading: fullName(community.me), member: true });

    const menu = headerMenuButton(page);
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    const panelId = await menu.getAttribute('aria-controls');
    expect(panelId, 'aria-controls names the panel').toBeTruthy();
    const panel = page.locator(`[id="${String(panelId)}"]`);
    await expect(panel).toHaveCount(1);
    await expect(panel).toBeHidden();
    await expect(mainNav(page)).toBeHidden();
    await expect(logoutButton(page)).toBeHidden();
    await expect(headerSearch(page)).toBeHidden();

    // Pointer: the button opens the panel it controls, which holds the search, the navigation and, last, "log out".
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText([...MAIN_NAV_LINKS]);
    await expect(panel.getByRole('combobox', { name: 'find people' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'log out', exact: true })).toBeVisible();
    const lastNavLink = await boxOf(
      panel.getByRole('link', { name: MAIN_NAV_LINKS.at(-1) ?? '', exact: true }),
      'last navigation link',
    );
    const panelLogout = await boxOf(panel.getByRole('button', { name: 'log out', exact: true }), '"log out"');
    expect(panelLogout.top, '"log out" is below the navigation').toBeGreaterThanOrEqual(lastNavLink.bottom);
    expect(overlapping([await boxOf(menu, 'menu button'), await boxOf(panel, 'menu panel')])).toEqual([]);
    expect(outsideViewport([await boxOf(panel, 'menu panel')], SMALL_VIEWPORT.width)).toEqual([]);

    // Escape closes it and gives focus back to the button.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
    await expect(menu).toBeFocused();

    // Keyboard: Enter opens it, and the panel follows its button in the focus order.
    await page.keyboard.press('Enter');
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    await expect(panel.getByRole('combobox', { name: 'find people' })).toBeFocused();
    // Space toggles it like any native button.
    await menu.focus();
    await page.keyboard.press('Space');
    await expect(menu).toHaveAttribute('aria-expanded', 'false');

    // A link in the panel navigates and closes the menu.
    await menu.click();
    await panel.getByRole('link', { name: 'friends', exact: true }).click();
    await expect(page).toHaveURL(/\/friends$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Friends', exact: true })).toBeVisible();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(mainNav(page)).toBeHidden();

    // The breakpoint itself: 639 px still has the button, 640 px shows the navigation instead.
    await page.setViewportSize({ width: HEADER_PANEL_BREAKPOINT_PX - 1, height: VIEWPORT_HEIGHT });
    await expect(menu).toBeVisible();
    await page.setViewportSize({ width: HEADER_PANEL_BREAKPOINT_PX, height: VIEWPORT_HEIGHT });
    await expect(menu).toBeHidden();
    await expect(mainNav(page)).toBeVisible();

    await page.setViewportSize(SMALL_VIEWPORT);
    await menu.click();
    await expect(panel).toBeVisible();
    await expectAccessible(page);
    await setColorScheme(page, 'dark');
    await expectAccessible(page);
  });

  test('B-130, F-98: the two-row header does not overflow at 640, 768 and 1024 px', async ({ community, pageAs }) => {
    const page = await pageAs(community.me);
    await page.setViewportSize({ width: HEADER_WIDTHS[0], height: VIEWPORT_HEIGHT });
    await openPage(page, memberPage('own profile', community));

    for (const width of HEADER_WIDTHS) {
      await test.step(`${String(width)} px`, async () => {
        await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
        await expect(headerMenuButton(page)).toBeHidden();

        const header = banner(page);
        await expect
          .poll(() => header.evaluate((element) => element.scrollWidth - element.clientWidth), {
            message: 'the header content is wider than the header',
          })
          .toBeLessThanOrEqual(0);

        const rowOne = [
          await boxOf(header.getByRole('link', { name: "let's chat", exact: true }), 'logo'),
          await boxOf(headerAvatarButton(page), 'avatar button'),
          await boxOf(headerSearch(page), 'search field'),
        ];
        const navLinks = await Promise.all(
          MAIN_NAV_LINKS.map((label) =>
            boxOf(mainNav(page).getByRole('link', { name: label, exact: true }), `"${label}" link`),
          ),
        );
        const logout = await boxOf(logoutButton(page), '"log out"');
        const rowTwo = [...navLinks, logout];
        const everything = [...rowOne, ...rowTwo];
        expect(outsideViewport(everything, width)).toEqual([]);
        expect(overlapping(everything)).toEqual([]);

        // Two rows (ADR-0015): the navigation and "log out" start below everything in the first row, and "log out"
        // ends the second row, after the last navigation link.
        const rowOneBottom = Math.max(...rowOne.map((box) => box.bottom));
        for (const item of rowTwo)
          expect(item.top, `${item.label} is in the second row`).toBeGreaterThanOrEqual(rowOneBottom - TOLERANCE_PX);
        expect(logout.left).toBeGreaterThan(Math.max(...navLinks.map((box) => box.right)));

        expect(await layoutProblems(page)).toEqual([]);
      });
    }

    await expectAccessible(page);
  });

  test('F-98: the collapsed header fits from 320 to 639 px', async ({ community, pageAs }) => {
    const page = await pageAs(community.me);
    await page.setViewportSize({ width: 320, height: VIEWPORT_HEIGHT });
    await openPage(page, { name: 'profile', path: '/', heading: fullName(community.me), member: true });

    for (const width of [320, 390, HEADER_PANEL_BREAKPOINT_PX - 1]) {
      await test.step(`${String(width)} px`, async () => {
        await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
        const row = [
          await boxOf(banner(page).getByRole('link', { name: "let's chat", exact: true }), 'logo'),
          await boxOf(headerAvatarButton(page), 'avatar button'),
          await boxOf(headerMenuButton(page), 'menu button'),
        ];
        expect(outsideViewport(row, width)).toEqual([]);
        expect(overlapping(row)).toEqual([]);
      });
    }

    await expectAccessible(page);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Welcome, about and names (F-95 – F-97, F-58)
// ---------------------------------------------------------------------------------------------------------------------

test.describe('welcome area', () => {
  test('F-95: two columns (brand panel + form) on large screens, one column on small screens', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: VIEWPORT_HEIGHT });
    await openPage(page, { name: 'sign up', path: '/welcome', heading: 'Sign up', member: false });
    const brandPanel = banner(page).getByText(
      'A small social network for profiles, friends, walls and one shared chat room.',
    );
    await expect(brandPanel).toBeVisible();

    for (const width of [WELCOME_TWO_COLUMNS, 1280, 1920]) {
      await test.step(`two columns at ${String(width)} px`, async () => {
        await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
        await expect
          .poll(async () => {
            const brand = await boxOf(banner(page), 'brand column');
            const form = await boxOf(page.getByRole('main'), 'form column');
            // Side by side: the form column starts right of the brand column and both start at the top.
            return form.left >= brand.right - TOLERANCE_PX && form.top < brand.bottom;
          })
          .toBe(true);
      });
    }

    for (const width of [320, SMALL_VIEWPORT.width, 768, WELCOME_TWO_COLUMNS - 1]) {
      await test.step(`one column at ${String(width)} px`, async () => {
        await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
        await expect
          .poll(async () => {
            const brand = await boxOf(banner(page), 'brand column');
            const form = await boxOf(page.getByRole('main'), 'form column');
            // Stacked: the form below the brand panel, both aligned on the same left edge.
            return form.top >= brand.bottom - TOLERANCE_PX && Math.abs(form.left - brand.left) <= TOLERANCE_PX;
          })
          .toBe(true);
      });
    }

    await expectAccessible(page);
  });

  test('F-96: sign up, log in and about are reachable from each other through visible lowercase links', async ({
    page,
  }) => {
    await openPage(page, { name: 'sign up', path: '/welcome', heading: 'Sign up', member: false });
    const main = page.getByRole('main');

    await expect(main.getByRole('listitem').filter({ hasText: 'Already a member?' })).toHaveText(
      'Already a member? log in',
    );
    await main.getByRole('link', { name: 'log in', exact: true }).click();
    await expect(page).toHaveURL(/\/welcome\/login$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Log in', exact: true })).toBeVisible();

    await expect(main.getByRole('listitem').filter({ hasText: 'Not a member yet?' })).toHaveText(
      'Not a member yet? sign up',
    );
    await main.getByRole('link', { name: 'about', exact: true }).click();
    await expect(page).toHaveURL(/\/welcome\/about$/);
    await expect(page.getByRole('heading', { level: 1, name: 'About', exact: true })).toBeVisible();

    await main.getByRole('link', { name: 'log in', exact: true }).click();
    await expect(page).toHaveURL(/\/welcome\/login$/);
    await main.getByRole('link', { name: 'sign up', exact: true }).click();
    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign up', exact: true })).toBeVisible();
    await main.getByRole('link', { name: 'about', exact: true }).click();
    await expect(page).toHaveURL(/\/welcome\/about$/);
    await main.getByRole('link', { name: 'sign up', exact: true }).click();
    await expect(page).toHaveURL(/\/welcome$/);

    // The links are visible text links, not hidden or icon-only.
    for (const label of ['log in', 'about']) {
      const link = main.getByRole('link', { name: label, exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveText(label);
    }

    await expectAccessible(page);
  });

  test('F-97, B-112: the about page describes the project and lists the stack without dead links', async ({ page }) => {
    await openPage(page, { name: 'about', path: '/welcome/about', heading: 'About', member: false });
    const main = page.getByRole('main');

    await expect(main.getByText(/is a small social network/)).toBeVisible();
    const stack = main.getByRole('region', { name: 'built with' });
    await expect(stack.getByRole('heading', { level: 2, name: 'built with' })).toBeVisible();
    const technologies = stack.getByRole('term');
    expect(await technologies.count()).toBeGreaterThanOrEqual(5);
    await expect(technologies.filter({ hasText: 'React 19' })).toHaveCount(1);
    await expect(technologies.filter({ hasText: 'Express 5 and TypeScript' })).toHaveCount(1);
    await expect(technologies.filter({ hasText: 'PostgreSQL and Drizzle ORM' })).toHaveCount(1);

    // B-112: no `href="#"` or empty links anywhere on the page; every link goes to an app page or a real http(s) URL.
    const hrefs = await page.locator('a').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    for (const href of hrefs) {
      expect(href, 'a link without a target').not.toBeNull();
      expect(href).not.toBe('');
      expect(href).not.toBe('#');
      expect(href ?? '', `"${String(href)}" is an app path, the skip link target or an absolute http(s) URL`).toMatch(
        /^(\/(?!\/)\S*|#main|https?:\/\/\S+)$/,
      );
    }

    await expectAccessible(page);
  });
});

test('F-58, B-110: names are rendered in their stored case wherever they appear', async ({ community, pageAs }) => {
  const { me, friend } = community;
  // Stored as entered: the API returns the name exactly as registered.
  expect(friend.me.firstName).toBe('mcKenna');
  expect(friend.me.lastName).toBe(friend.lastName);
  const name = fullName(friend);

  const page = await pageAs(me);
  await openPage(page, memberPage("a friend's profile", community));
  const heading = page.getByRole('heading', { level: 1 });
  // The DOM text and the accessible name both keep the stored case (F-58: casing only ever in CSS).
  expect(await heading.textContent()).toBe(name);
  await expect(heading).toHaveAccessibleName(name);
  await expect(page.getByRole('img', { name: `${name}'s profile picture` })).toBeVisible();

  await openPage(page, memberPage('friends', community));
  const row = page.getByRole('main').getByRole('link', { name, exact: true });
  await expect(row).toBeVisible();
  expect(await row.textContent()).toBe(name);

  // In the header search (the friend's name typed in lower case finds it, and it shows stored case).
  await revealHeaderPanel(page);
  await headerSearch(page).fill(friend.lastName.toLowerCase());
  const option = page.getByRole('option', { name, exact: true });
  await expect(option).toBeVisible();
  expect((await option.textContent())?.trim()).toBe(name);

  // The own wall shows the friend as the author of the post, in stored case.
  await page.keyboard.press('Escape');
  await openPage(page, memberPage('own profile', community));
  const author = page.getByRole('main').getByRole('link', { name, exact: true }).first();
  await expect(author).toBeVisible();
  expect(await author.textContent()).toBe(name);

  await expectAccessible(page);
});

// ---------------------------------------------------------------------------------------------------------------------
// Every page: overflow sweep, structure and axe (F-98, F-100, F-101, F-103, F-104)
// ---------------------------------------------------------------------------------------------------------------------

async function sweepWidths(page: Page): Promise<void> {
  for (const width of SWEEP_WIDTHS) {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    await expect.poll(() => layoutProblems(page), { message: `layout at ${String(width)} px` }).toEqual([]);
  }
}

/**
 * The skip link is the first Tab stop, shows on focus and targets `<main id="main">` (F-103). Checked after the axe
 * runs: while focused it sits over the top-left corner of the page by design, which axe would report as an obscured
 * target for whatever is underneath.
 */
async function expectSkipLinkFirst(page: Page): Promise<void> {
  // Nothing has had focus since the page loaded, so the first Tab starts at the top of the document.
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'skip to content' });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeInViewport();
  await expect(skipLink).toHaveAttribute('href', '#main');
}

async function auditPage(page: Page, pageCase: PageCase): Promise<void> {
  await expectAccessibleStructure(page, pageCase);
  await expectAccessible(page);
  await setColorScheme(page, 'dark');
  await expectAccessibleStructure(page, pageCase);
  await expectAccessible(page);
}

test.describe('every visitor page', () => {
  for (const pageCase of VISITOR_PAGES) {
    test(`F-98, B-115, B-126: ${pageCase.name} works from 320 to 1920 px without sideways scrolling or overlaps`, async ({
      page,
    }) => {
      await openPage(page, pageCase);
      await sweepWidths(page);
      await expectAccessible(page);
    });

    test(`F-100, F-101, F-103, F-104, B-102, B-107, B-108, B-121: ${pageCase.name} is axe clean and well structured in light and dark mode`, async ({
      page,
    }) => {
      await openPage(page, pageCase);
      await auditPage(page, pageCase);
      await expectSkipLinkFirst(page);
    });
  }
});

test.describe('every member page', () => {
  for (const name of MEMBER_PAGE_NAMES) {
    test(`F-98, B-114, B-115, B-126: ${name} works from 320 to 1920 px without sideways scrolling or overlaps`, async ({
      community,
      pageAs,
    }) => {
      const pageCase = memberPage(name, community);
      const page = await pageAs(community.me);
      await openPage(page, pageCase);
      await sweepWidths(page);
      await expectAccessible(page);
    });

    test(`F-100, F-101, F-103, F-104, B-102, B-107, B-108, B-121: ${name} is axe clean and well structured in light and dark mode`, async ({
      community,
      pageAs,
    }) => {
      const pageCase = memberPage(name, community);
      const page = await pageAs(community.me);
      await openPage(page, pageCase);
      await auditPage(page, pageCase);
      await expectSkipLinkFirst(page);
    });
  }

  test('F-100: open overlays (menu panel, search results, upload dialog) are axe clean in light and dark mode', async ({
    community,
    pageAs,
  }) => {
    const page = await pageAs(community.me);
    await page.setViewportSize(SMALL_VIEWPORT);
    await openPage(page, memberPage('own profile', community));

    await revealHeaderPanel(page);
    await headerSearch(page).fill(community.friend.lastName);
    await expect(page.getByRole('option', { name: fullName(community.friend), exact: true })).toBeVisible();
    await expectAccessible(page);
    await setColorScheme(page, 'dark');
    await expectAccessible(page);

    await page.keyboard.press('Escape');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1440, height: VIEWPORT_HEIGHT });
    await headerAvatarButton(page).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectAccessible(page);
    await setColorScheme(page, 'dark');
    await expectAccessible(page);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Tokens only (F-99) and fixed avatar sizes (B-125)
// ---------------------------------------------------------------------------------------------------------------------

/** The colour tokens of tokens.css (`--color-*`); the dark set redefines the same names. */
const COLOUR_TOKENS = [
  'paper',
  'ink',
  'ink-muted',
  'rule',
  'rule-strong',
  'surface',
  'on-accent',
  'apricot',
  'sky',
  'olive',
  'sand',
  'vermilion',
  'rose',
  'blush',
  'rust',
  'accent',
  'error',
] as const;
/** The type scale of tokens.css (`--text-micro` … `--text-display-xl`) in px at the 16 px root size. */
const TYPE_SCALE_PX = [12, 14, 16, 17, 21, 24, 31, 39, 49, 72] as const;
/** The only typeface (maw-design-system §2, SIL OFL 1.1, self-hosted). */
const BRAND_FONT = 'Schibsted Grotesk';

interface TokenAudit {
  /** `<element> <property>: <value>` for every rendered colour that is neither a colour token nor transparent. */
  colours: string[];
  /** Text in another typeface than the brand font. */
  fonts: string[];
  /** Text in a size outside the type scale. */
  sizes: string[];
}

/**
 * Every visible element's resolved colours (text, background, drawn borders and outlines) and, for elements with their
 * own text, the typeface and size, compared with the token values the page itself defines on `:root` right now (so
 * the same check covers the light and the dark token set). Raw values in component CSS show up here as off-palette.
 */
async function nonTokenStyles(page: Page): Promise<TokenAudit> {
  return page.evaluate(
    ({ tokens, scale, brandFont }) => {
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement('span');
      document.body.append(probe);
      const palette = new Set<string>(['rgba(0, 0, 0, 0)']);
      for (const token of tokens) {
        probe.style.color = '';
        probe.style.color = root.getPropertyValue(`--color-${token}`).trim();
        palette.add(getComputedStyle(probe).color);
      }
      probe.remove();

      const colours = new Set<string>();
      const fonts = new Set<string>();
      const sizes = new Set<string>();
      for (const element of document.body.querySelectorAll('*')) {
        if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
        if (!element.checkVisibility({ visibilityProperty: true })) continue;
        const style = getComputedStyle(element);
        const classes = [...element.classList].join('.');
        const where = `<${element.tagName.toLowerCase()}${classes === '' ? '' : `.${classes}`}>`;
        const check = (property: string, value: string): void => {
          if (!palette.has(value)) colours.add(`${where} ${property}: ${value}`);
        };
        check('color', style.color);
        check('background-color', style.backgroundColor);
        for (const side of ['top', 'right', 'bottom', 'left']) {
          const drawn =
            style.getPropertyValue(`border-${side}-style`) !== 'none' &&
            Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0;
          if (drawn) check(`border-${side}-color`, style.getPropertyValue(`border-${side}-color`));
        }
        if (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) {
          check('outline-color', style.outlineColor);
        }

        const ownText = [...element.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
        );
        if (!ownText) continue;
        const family = (style.fontFamily.split(',')[0] ?? '').trim().replaceAll(/["']/g, '');
        if (family !== brandFont) fonts.add(`${where} font-family: ${style.fontFamily}`);
        const size = Number.parseFloat(style.fontSize);
        if (!scale.some((step) => Math.abs(step - size) < 0.05)) sizes.add(`${where} font-size: ${style.fontSize}`);
      }
      return { colours: [...colours], fonts: [...fonts], sizes: [...sizes] };
    },
    { tokens: COLOUR_TOKENS, scale: TYPE_SCALE_PX, brandFont: BRAND_FONT },
  );
}

/**
 * Polled: right after a colour-scheme switch, rows whose rule colour eases (`transition: border-color`) still show the
 * other scheme's token for `--duration-fast`. A raw value in the CSS never settles, so it still fails the poll.
 */
async function expectTokensOnly(page: Page, label: string): Promise<void> {
  await expect
    .poll(() => nonTokenStyles(page), { message: `${label}: colours, typefaces and sizes outside the tokens` })
    .toEqual({ colours: [], fonts: [], sizes: [] });
}

test.describe('design tokens', () => {
  test('F-99: every colour, typeface and text size on every page comes from the tokens, in light and dark mode', async ({
    community,
    pageAs,
  }) => {
    const page = await pageAs(community.me);
    const pages = [...MEMBER_PAGE_NAMES.map((name) => memberPage(name, community))];
    for (const pageCase of pages) {
      await test.step(pageCase.name, async () => {
        await page.emulateMedia({ colorScheme: 'light' });
        await openPage(page, pageCase);
        await expectTokensOnly(page, `${pageCase.name} (light)`);
        await setColorScheme(page, 'dark');
        await expectTokensOnly(page, `${pageCase.name} (dark)`);
      });
    }
    await expectAccessible(page);
  });

  test('F-99: the visitor pages use only token colours, the brand typeface and the type scale', async ({ page }) => {
    for (const pageCase of VISITOR_PAGES) {
      await test.step(pageCase.name, async () => {
        await page.emulateMedia({ colorScheme: 'light' });
        await openPage(page, pageCase);
        await expectTokensOnly(page, `${pageCase.name} (light)`);
        await setColorScheme(page, 'dark');
        await expectTokensOnly(page, `${pageCase.name} (dark)`);
      });
    }
    await expectAccessible(page);
  });

  test('B-125: avatars keep their token size at every width: square 40, 64 and 128 px, the picture covering it', async ({
    community,
    pageAs,
  }) => {
    const { me, friend } = community;
    const page = await pageAs(me);
    const main = page.getByRole('main');
    const picture = `${fullName(friend)}'s profile picture`;
    const cases = [
      {
        label: 'profile picture (large)',
        pageCase: memberPage("a friend's profile", community),
        avatar: () => main.getByRole('img', { name: picture, exact: true }),
        size: 128,
      },
      {
        label: 'wall post author (medium)',
        pageCase: memberPage('own profile', community),
        avatar: () =>
          main
            .getByRole('article')
            .filter({ hasText: 'A post with a long word' })
            .getByRole('img', { name: picture, exact: true }),
        size: 64,
      },
      {
        label: 'friends list row (small)',
        pageCase: memberPage('friends', community),
        avatar: () =>
          main
            .getByRole('listitem')
            .filter({ hasText: fullName(friend) })
            .getByRole('img', { name: picture, exact: true }),
        size: 40,
      },
    ];

    for (const { label, pageCase, avatar, size } of cases) {
      await test.step(label, async () => {
        await page.setViewportSize({ width: 1440, height: VIEWPORT_HEIGHT });
        await openPage(page, pageCase);
        for (const width of [1440, 768, 320]) {
          await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
          const image = avatar();
          await image.scrollIntoViewIfNeeded();
          const box = await boxOf(image, `${label} at ${String(width)} px`);
          // Legacy sized avatars in vw (27 px on a laptop, 6 px on a phone); the token size never follows the viewport.
          expect(box.right - box.left, `${label} width at ${String(width)} px`).toBeCloseTo(size, 0);
          expect(box.bottom - box.top, `${label} height at ${String(width)} px`).toBeCloseTo(size, 0);
          expect(await image.evaluate((element) => getComputedStyle(element).objectFit)).toBe('cover');
        }
      });
    }
    await expectAccessible(page);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Footer (ADR-0015, maw-design-system §6)
// ---------------------------------------------------------------------------------------------------------------------

test.describe('footer', () => {
  async function expectFooter(page: Page, aboutPath: string): Promise<void> {
    const footer = page.getByRole('contentinfo');
    await expect(footer).toBeVisible();
    await expect(footer.getByRole('link')).toHaveText(['about', 'github']);
    await expect(footer.getByRole('link', { name: 'about' })).toHaveAttribute('href', aboutPath);
    await expect(footer.getByRole('link', { name: 'github' })).toHaveAttribute(
      'href',
      'https://github.com/Arnoldovna/social-network',
    );
    await expect(footer).toContainText('© 2026');
    expect(await layoutProblems(page)).toEqual([]);
  }

  test('the welcome pages end with the footer; its "about" is the visitor about page', async ({ page }) => {
    await openPage(page, { name: 'sign up', path: '/welcome', heading: 'Sign up', member: false });
    await expectFooter(page, '/welcome/about');
  });

  test('the app pages end with the footer; its "about" opens the member about page', async ({ community, pageAs }) => {
    const page = await pageAs(community.me);
    await openPage(page, memberPage('own profile', community));
    await expectFooter(page, '/about');

    await page.getByRole('contentinfo').getByRole('link', { name: 'about' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'About' })).toBeVisible();
    await expect(page).toHaveURL(/\/about$/);
    // Members are signed in already: no sign-up and log-in links, but the site navigation stays.
    await expect(page.getByRole('main').getByRole('link', { name: 'sign up' })).toHaveCount(0);
    await expect(banner(page)).toBeVisible();
    await expectAccessible(page);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Keyboard and motion (F-102, F-104)
// ---------------------------------------------------------------------------------------------------------------------

test.describe('keyboard and motion', () => {
  test('F-102, B-106, B-123: a keyboard walk through the profile reaches every control with a visible focus ring', async ({
    community,
    pageAs,
  }) => {
    const page = await pageAs(community.me);
    await openPage(page, memberPage('own profile', community));

    const stops = await tabWalk(page);
    expect(focusProblems(stops)).toEqual([]);
    expect(stops[0]?.name).toBe('skip to content');

    // The header in DOM order = visual order (WCAG 2.4.3); below 640 px the panel stays closed during the walk.
    const expectedHeader = usesHeaderPanel(page)
      ? ["let's chat", 'change profile picture', 'menu']
      : ["let's chat", 'change profile picture', 'find people', ...MAIN_NAV_LINKS, 'log out'];
    expect(stops.filter((stop) => stop.inBanner).map((stop) => stop.name)).toEqual(expectedHeader);

    // The page content comes after the header and reaches the profile's own controls and the wall.
    const firstMain = stops.findIndex((stop) => stop.inMain);
    const lastBanner = stops.map((stop) => stop.inBanner).lastIndexOf(true);
    expect(firstMain).toBeGreaterThan(lastBanner);
    const mainNames = stops.filter((stop) => stop.inMain).map((stop) => stop.name);
    expect(mainNames).toContain('change profile picture');
    expect(mainNames).toContain(fullName(community.friend).toLowerCase());

    // The skip link moves focus to <main>; the next Tab is inside the content, past the whole header.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: fullName(community.me), exact: true })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    await page.keyboard.press('Tab');
    const afterSkip = await currentFocusStop(page);
    expect(afterSkip.inMain, `"${afterSkip.name}" is inside the main content`).toBe(true);

    await expectAccessible(page);
  });

  test('F-102: a keyboard walk through the sign-up page reaches the form and the links with a visible focus ring', async ({
    page,
  }) => {
    await openPage(page, { name: 'sign up', path: '/welcome', heading: 'Sign up', member: false });

    const stops = await tabWalk(page);
    expect(focusProblems(stops)).toEqual([]);
    expect(stops.map((stop) => stop.name)).toEqual([
      'skip to content',
      "let's chat",
      'first name',
      'last name',
      'email',
      expect.stringMatching(/^password/),
      'sign up',
      'log in',
      'about',
      // The footer (ADR-0015).
      'about',
      'github',
    ]);

    await expectAccessible(page);
  });

  test('F-104: motion runs only without prefers-reduced-motion', async ({ community, pageAs }) => {
    const page = await pageAs(community.me);
    const logo = banner(page).getByRole('link', { name: "let's chat", exact: true });
    const animationOf = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).animationName);

    // Control: without a preference the page does move (wall posts fade in; on devices that can hover, a hovered
    // link shakes), so the reduced-motion assertions below are able to fail.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openPage(page, memberPage('own profile', community));
    expect(await movingElements(page)).not.toEqual([]);
    const canHover = await page.evaluate(() => matchMedia('(hover: hover)').matches);
    if (canHover) {
      await logo.hover();
      await expect.poll(() => animationOf(logo)).toBe('shake');
    }
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('smooth');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openPage(page, memberPage('own profile', community));
    await logo.hover();
    await expect.poll(() => animationOf(logo)).toBe('none');
    await revealHeaderPanel(page);
    await mainNav(page).getByRole('link', { name: 'friends', exact: true }).hover();
    expect(await movingElements(page)).toEqual([]);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');

    await expectAccessible(page);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Loading, error and empty states (F-105, B-82)
// ---------------------------------------------------------------------------------------------------------------------

test.describe('loading, error and empty states', () => {
  test('B-82: a failing GET /api/me shows "try again" instead of a blank page, and try again recovers', async ({
    community,
    pageAs,
  }) => {
    const page = await pageAs(community.me);
    const me = await failApi(page, /^\/api\/me$/);
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1, name: 'Something went wrong', exact: true })).toBeVisible();
    const alert = page.getByRole('alert').filter({ hasText: 'This page could not be loaded.' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Something went wrong on our side. Please try again.');
    // One plain sentence, never the problem detail or a stack trace.
    await expect(page.getByText('An unexpected error occurred.')).toHaveCount(0);
    expect(me.failures()).toBeGreaterThan(0);
    await expectAccessible(page);

    me.recover();
    await alert.getByRole('button', { name: 'try again' }).click();
    await expect(page.getByRole('heading', { level: 1, name: fullName(community.me), exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'This page could not be loaded.' })).toHaveCount(0);
    await expectAccessible(page);
  });

  test('F-105: the first navigation shows "loading…" while the signed-in user is fetched', async ({
    community,
    pageAs,
  }) => {
    const page = await pageAs(community.me);
    const me = await holdGets(page, /^\/api\/me$/);
    await page.goto('/');
    await expect(page.getByRole('status').filter({ hasText: /^loading…$/ })).toBeVisible();

    me.release();
    await expect(page.getByRole('heading', { level: 1, name: fullName(community.me), exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /^loading/ })).toHaveCount(0);
    await expectAccessible(page);
  });

  for (const view of DATA_VIEWS) {
    test(`F-105: ${view.name} shows a loading state, then its content`, async ({ community, pageAs }) => {
      const page = await pageAs(community.me);
      const gate = await holdGets(page, view.endpoint(community));

      await page.goto(view.path(community));
      await expect(page.getByRole('status').filter({ hasText: view.loading })).toBeVisible();
      // Never a blank screen: the site header is there while the view loads.
      await expect(headerAvatarButton(page)).toBeVisible();

      gate.release();
      await view.loaded(page, community);
      await expect(page.getByRole('status').filter({ hasText: /^loading/ })).toHaveCount(0);
      await expectAccessible(page);
    });

    test(`F-105, B-82: ${view.name} shows an error with "try again" when the API fails, and recovers`, async ({
      community,
      pageAs,
    }) => {
      const page = await pageAs(community.me);
      const api = await failApi(page, view.endpoint(community));

      await page.goto(view.path(community));
      const alert = page.getByRole('alert').filter({ hasText: view.errorTitle });
      await expect(alert).toBeVisible();
      await expect(alert).toContainText('Something went wrong on our side. Please try again.');
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(headerAvatarButton(page)).toBeVisible();
      expect(api.failures()).toBeGreaterThan(0);
      await expectAccessible(page);
      await setColorScheme(page, 'dark');
      await expectAccessible(page);

      api.recover();
      await alert.getByRole('button', { name: 'try again' }).click();
      await view.loaded(page, community);
      await expect(page.getByRole('alert').filter({ hasText: view.errorTitle })).toHaveCount(0);
      await expect(page.getByRole('status').filter({ hasText: /^loading/ })).toHaveCount(0);
      await expectAccessible(page);
    });
  }

  test('F-105: the header search shows an error with "try again" and recovers', async ({ community, pageAs }) => {
    const page = await pageAs(community.me);
    const search = await failApi(page, /^\/api\/users\/search$/);
    await openPage(page, memberPage('own profile', community));

    await revealHeaderPanel(page);
    await headerSearch(page).fill(community.friend.lastName);
    const retry = banner(page).getByRole('button', { name: 'try again' });
    await expect(retry).toBeVisible();
    expect(search.failures()).toBeGreaterThan(0);
    await expectAccessible(page);

    search.recover();
    await retry.click();
    await expect(page.getByRole('option', { name: fullName(community.friend), exact: true })).toBeVisible();
    await expectAccessible(page);
  });

  test('F-105: own data views show their empty states', async ({ createUser, pageAs }) => {
    // A user without friends, requests or posts: every list of their own is empty.
    const loner = await createUser();
    const page = await pageAs(loner);

    await openPage(page, { name: 'profile', path: '/', heading: fullName(loner), member: true });
    await expect(page.getByText('No posts yet.')).toBeVisible();
    await expect(page.getByText('Write the first one.')).toBeVisible();

    await openPage(page, { name: 'friends', path: '/friends', heading: 'Friends', member: true });
    const main = page.getByRole('main');
    await expect(main.getByText('No friend requests right now.')).toBeVisible();
    await expect(main.getByText('You have not added any friends yet.')).toBeVisible();
    await expect(main.getByText('No sent requests.')).toBeVisible();
    await expectAccessible(page);

    // A friend's wall that is still empty.
    const stranger = await createUser();
    await befriend(loner, stranger);
    await openPage(page, {
      name: 'profile',
      path: `/users/${String(stranger.id)}`,
      heading: fullName(stranger),
      member: true,
    });
    await expect(page.getByText('No posts yet.')).toBeVisible();
    await expectAccessible(page);
    await setColorScheme(page, 'dark');
    await expectAccessible(page);
  });

  test('F-105: the shared views show their empty states for an empty answer', async ({ community, pageAs }) => {
    const page = await pageAs(community.me);
    // The chat room and the online list are shared with every other spec, so "empty" is an API answer stubbed here.
    // The socket is held silent for this page, so no live event from another spec can fill the lists meanwhile.
    await page.routeWebSocket(/\/socket\.io\//, () => undefined);
    await page.route(
      (url) => url.pathname === '/api/presence',
      (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
    );
    await page.route(
      (url) => url.pathname === '/api/chat/messages',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: [], nextCursor: null }),
        }),
    );

    await openPage(page, { name: 'online', path: '/online', heading: 'Online', member: true });
    await expect(page.getByText('Nobody else is online right now.')).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: 'go to the chat' })).toBeVisible();
    await expectAccessible(page);

    await openPage(page, { name: 'chat', path: '/chat', heading: 'Chat', member: true });
    await expect(page.getByText('No messages yet.')).toBeVisible();
    await expect(headerAvatarButton(page)).toBeVisible();
    await expectAccessible(page);
  });
});
