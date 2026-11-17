import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against the production images in the isolated compose project `social-network-e2e`, started by
 * `pnpm test:e2e` (scripts/run-e2e.mjs), which also sets E2E_BASE_URL (default port 8183). There is deliberately no
 * `webServer`: nothing may silently reuse the dev or demo stack (conventions §6, ADR-0016, ADR-0019 §6). Phase-5
 * units run against the stack `pnpm e2e:up` prints.
 */
const baseURL = process.env['E2E_BASE_URL'];
if (!baseURL) {
  throw new Error('E2E_BASE_URL is not set. Run `pnpm test:e2e`, or `pnpm e2e:up` and pass the URL it prints.');
}

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/readme-media.spec.ts'], // README media has its own config (portfolio-readme skill)
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0, // a flaky test is a failing test: fix the cause (quality-gate), never retry it green
  ...(process.env['CI'] ? { workers: 2 } : {}),
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
