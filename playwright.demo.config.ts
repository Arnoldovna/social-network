import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke test of the GitHub Pages demo (ADR-0020): the built demo (`pnpm build:demo`, apps/web/dist-demo) served by
 * `vite preview` under the Pages base path, with msw answering the API in the browser. No Docker stack and no API:
 * unlike the e2e suite (playwright.config.ts), this config starts its own static server. The port is fixed and
 * strict, so it fails instead of testing whatever else listens there.
 */
const PORT = Number(process.env['DEMO_PORT'] ?? 4180);
const BASE_PATH = '/social-network/';

export default defineConfig({
  testDir: './e2e/demo',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}${BASE_PATH}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `pnpm --filter @app/web exec vite preview --mode demo --host 127.0.0.1 --port ${String(PORT)} --strictPort`,
    url: `http://127.0.0.1:${String(PORT)}${BASE_PATH}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
