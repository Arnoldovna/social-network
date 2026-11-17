import { expect, test } from '@playwright/test';

/**
 * Phase 1a smoke test: the production images are up behind nginx (scripts/run-e2e.mjs starts them) and the SPA shell
 * loads under the strict CSP from apps/web/nginx.conf. Phase 1c extends this file (welcome page, axe, anonymous
 * socket rejection); Phase 5 removes it only once its checks are fully covered elsewhere.
 */

// Chromium reports every blocked load or inline execution as a console error that names the policy, e.g.
// "Loading the font '…' violates the following Content Security Policy directive: "font-src 'none'". …".
const CSP_CONSOLE_MARKER = 'Content Security Policy';

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
    // The policy must exist and must not allow inline scripts (B-107), otherwise the console check below proves nothing.
    expect(headers['content-security-policy']).toContain("script-src 'self'");
    expect(headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(await response.text()).toMatch(/<html lang="en">/);
  });

  test('the page renders without CSP violations or uncaught errors', async ({ page }) => {
    const cspViolations: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes(CSP_CONSOLE_MARKER)) {
        cspViolations.push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    const response = await page.goto('/');

    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // React rendered the placeholder page, so the module script and the stylesheet were allowed to load.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Fonts load lazily once text uses them; wait until they settle so a blocked font-src would already be reported.
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    expect(cspViolations, cspViolations.join('\n')).toEqual([]);
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });
});
