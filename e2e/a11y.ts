import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Waits until every finite CSS transition and animation on the page has finished. axe samples computed colours, so a
 * check that starts while a colour transition runs (e.g. the 120ms button transition right after a colour-scheme
 * switch) measures an in-between colour pair no user ever reads, and reports a contrast failure that is not there.
 */
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY);
    // A cancelled animation rejects `finished`; it no longer affects the computed style, so it counts as settled.
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
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
