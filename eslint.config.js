// @ts-check
// Root config: packages/shared, apps/api, root scripts and config files.
// apps/web has its own eslint.config.js (ESLint resolves the nearest config per file).
import { defineConfig } from 'eslint/config';
import globals from 'globals';

import {
  apiNoTestImports,
  featureBoundaries,
  ignores,
  noImportCycles,
  prettier,
  testFileRules,
  typescriptStrict,
} from './eslint.shared.js';

export default defineConfig([
  ignores,
  ...typescriptStrict(import.meta.dirname),
  { languageOptions: { globals: { ...globals.node } } },
  featureBoundaries({
    files: ['apps/api/src/**/*.ts'],
    tsconfigs: ['apps/api/tsconfig.json', 'packages/*/tsconfig.json'],
  }),
  noImportCycles({
    files: ['apps/api/**/*.ts', 'packages/*/**/*.ts', 'e2e/**/*.ts', '*.config.ts'],
    tsconfigs: ['apps/api/tsconfig.json', 'packages/*/tsconfig.json', 'tsconfig.json'],
  }),
  apiNoTestImports,
  {
    // CLI scripts report to the terminal; no-console guards application code (B-101), not tooling.
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  testFileRules(['**/__tests__/**', '**/*.test.ts', 'e2e/**']),
  prettier,
]);
