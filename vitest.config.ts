import { defineConfig } from 'vitest/config';

// Each package declares its own project(s). Names follow "<kind>:<package>" so the root scripts
// can filter with --project "unit:*" / --project "integration:*".
export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'apps/*/vitest.config.ts',
      'apps/*/vitest.integration.config.ts',
      // Root tooling scripts (Node built-ins only, plain .mjs).
      { test: { name: 'unit:scripts', environment: 'node', include: ['scripts/**/*.test.mjs'] } },
    ],
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**', 'packages/*/src/**', 'scripts/**'],
      exclude: ['**/__tests__/**', '**/*.test.ts', '**/*.test.mjs', '**/*.d.ts'],
    },
  },
});
