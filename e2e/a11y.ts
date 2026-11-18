import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Longest wait for running transitions and animations before axe; the app's longest finite one is far shorter. */
const SETTLE_TIMEOUT_MS = 5_000;

/**
 * Waits until no finite CSS transition or animation is running and none has started for two animation frames. axe
 * samples computed colours, so a check that starts while a colour transition runs measures an in-between colour pair
 * no user ever reads, and reports a contrast failure that is not there. Waiting for the animations that exist at one
 * moment is not enough: a transition can start a frame later, e.g. when Chromium re-evaluates `:hover` after a
 * navigation renders a button under the pointer that just clicked a link (the 120 ms outlined-button transition).
 *
 * Only running animations count: infinite ones never settle, paused ones never progress (their `finished` would never
 * resolve), and a cancelled one rejects `finished` and counts as settled. Something that keeps restarting fails after
 * `SETTLE_TIMEOUT_MS` with the animations it waited for, instead of running into the bare test timeout.
 */
async function settleAnimations(page: Page): Promise<void> {
  const unsettled = await page.evaluate(async (timeoutMs) => {
    const deadline = performance.now() + timeoutMs;
    const nextFrame = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    const describe = (animation: Animation): string => {
      const kind =
        animation instanceof CSSTransition
          ? `transition of ${animation.transitionProperty}`
          : animation instanceof CSSAnimation
            ? `animation ${animation.animationName}`
            : 'script animation';
      const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
      const where =
        target === null
          ? 'no target'
          : `<${target.tagName.toLowerCase()} class="${target.getAttribute('class') ?? ''}">`;
      return `${kind} on ${where}`;
    };
    for (;;) {
      await nextFrame();
      await nextFrame();
      const running = document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === 'running' &&
            animation.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY,
        );
      if (running.length === 0) return [];
      const remaining = deadline - performance.now();
      if (remaining <= 0) return running.map(describe);
      await Promise.race([
        Promise.all(running.map((animation) => animation.finished.catch(() => undefined))),
        new Promise<void>((resolve) => {
          setTimeout(resolve, remaining);
        }),
      ]);
    }
  }, SETTLE_TIMEOUT_MS);
  if (unsettled.length > 0) {
    throw new Error(
      `Animations still running after ${String(SETTLE_TIMEOUT_MS)} ms, so axe would sample in-between colours: ` +
        unsettled.join('; '),
    );
  }
}

/** Fails on serious and critical WCAG 2.2 A/AA violations (Definition of Done: no critical axe findings). */
export async function expectNoA11yViolations(page: Page): Promise<void> {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking, blocking.map((v) => `${v.id}: ${v.help} (${String(v.nodes.length)} nodes)`).join('\n')).toEqual([]);
}

/**
 * Emulates the light or dark `prefers-color-scheme` and waits until the page applied it. tokens.css switches the token
 * set together with `color-scheme`, so a computed `color-scheme` of `scheme` proves the matching colours are active.
 */
export async function setColorScheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(scheme);
}

/** Axe in the dark token set (ADR-0015); the page stays dark afterwards. */
export async function expectNoA11yViolationsInDarkMode(page: Page): Promise<void> {
  await setColorScheme(page, 'dark');
  await expectNoA11yViolations(page);
}

/** Axe in the current (light) and then the dark token set (main screens, ADR-0015); the page stays dark afterwards. */
export async function expectNoA11yViolationsInBothSchemes(page: Page): Promise<void> {
  await expectNoA11yViolations(page);
  await expectNoA11yViolationsInDarkMode(page);
}
