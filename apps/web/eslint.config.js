// @ts-check
// React app config. Reuses the shared blocks (strict TS, feature boundaries, import cycles, ignores, prettier) from
// the root.
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

import {
  featureBoundaries,
  ignores,
  noImportCycles,
  prettier,
  testFileRules,
  typescriptStrict,
} from '../../eslint.shared.js';

export default defineConfig([
  ignores,
  ...typescriptStrict(import.meta.dirname),
  reactHooks.configs.flat.recommended,
  { languageOptions: { globals: { ...globals.browser } } },
  testFileRules(['**/__tests__/**', '**/*.test.{ts,tsx}']),
  featureBoundaries({ files: ['src/**/*.{ts,tsx}'], tsconfigs: ['tsconfig.app.json'] }),
  noImportCycles({
    files: ['src/**/*.{ts,tsx}', '*.config.ts'],
    tsconfigs: ['tsconfig.app.json', 'tsconfig.node.json'],
  }),
  prettier,
]);
