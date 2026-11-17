import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'integration:api',
    environment: 'node',
    include: ['src/**/*.int.test.ts', 'test/**/*.int.test.ts'],
    // One Postgres + Redis per run and a migrated template database (test/global-setup.ts); every test file then gets
    // its own clone (test/setup-database.ts), so files run in parallel (conventions §7, ADR-0016).
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-database.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
