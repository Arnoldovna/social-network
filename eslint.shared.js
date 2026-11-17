// @ts-check
// Building blocks shared by the root config and app-level configs (ESLint resolves the nearest
// eslint.config.js per file, so apps/web can add framework rules while reusing these).
import js from '@eslint/js';
import { globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import boundaries from 'eslint-plugin-boundaries';
import { createNodeResolver, importX } from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

/**
 * Workspace packages resolve to their TypeScript source through the `development` export condition (as in tsx, Vite
 * and `customConditions`), so the resolvers see `@app/shared` before it is built. The rest are the resolvers' defaults.
 */
const TS_RESOLVER_CONDITIONS = [
  'development',
  'types',
  'import',
  'esm2020',
  'es2020',
  'es2015',
  'require',
  'node',
  'node-addons',
  'browser',
  'default',
];
const NODE_RESOLVER_CONDITIONS = ['development', 'import', 'require', 'default'];
const TS_AND_JS_EXTENSIONS = ['.ts', '.tsx', '.cts', '.mts', '.js', '.jsx', '.cjs', '.mjs'];

/**
 * The TypeScript resolver options both import plugins use, so boundaries and no-cycle resolve every import alike.
 * @param {string[]} tsconfigs
 */
function typescriptResolverOptions(tsconfigs) {
  return {
    alwaysTryTypes: true,
    project: tsconfigs,
    noWarnOnMultipleProjects: true,
    conditionNames: TS_RESOLVER_CONDITIONS,
  };
}

export const ignores = globalIgnores([
  '**/dist/',
  '**/coverage/',
  '**/playwright-report/',
  '**/test-results/',
  '**/drizzle/',
  '**/.vite/',
]);

/** @param {string} rootDir */
export function typescriptStrict(rootDir) {
  return [
    {
      files: ['**/*.{js,mjs,cjs,ts,mts,cts,tsx}'],
      extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir: rootDir },
      },
      rules: {
        '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        'no-console': 'error',
        eqeqeq: ['error', 'always'],
      },
    },
    { files: ['**/*.{js,mjs,cjs}'], extends: [tseslint.configs.disableTypeChecked] },
  ];
}

/**
 * Feature isolation (OVERVIEW §5): files inside features/<name>/ may import their own files freely, but another
 * feature only through its public entry point (index.ts). shared/, config/ and db/ never import features.
 * The web app shell (app/: store, router, layouts, header) uses features only through their index.ts, plus shared/.
 * The Zod contract `@app/shared` is open to every element.
 * @param {{ files: string[], tsconfigs: string[] }} options
 */
export function featureBoundaries({ files, tsconfigs }) {
  return {
    files,
    plugins: { boundaries },
    settings: {
      'import/resolver': { typescript: typescriptResolverOptions(tsconfigs) },
      'boundaries/elements': [
        // `@app/shared` resolves into packages/shared/src (development condition). Matched on the full path and listed
        // first, so its folder name never classifies it as an app's own `shared` element.
        { type: 'contract', pattern: '**/packages/shared/**', partialMatch: false },
        { type: 'feature', pattern: 'features/*', capture: ['feature'] },
        { type: 'shared', pattern: 'shared' },
        { type: 'config', pattern: 'config' },
        { type: 'db', pattern: 'db' },
        { type: 'app', pattern: 'app' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            { allow: { to: { module: { origin: 'external' } } } },
            { allow: { dependency: { relationship: { to: 'internal' } } } },
            { allow: { to: { element: { type: 'contract' } } } },
            {
              from: { element: { types: ['feature', 'app'] } },
              allow: { to: { element: { type: 'feature', fileInternalPath: 'index.ts' } } },
            },
            {
              from: { element: { types: ['feature', 'db'] } },
              allow: { to: { element: { types: ['shared', 'config', 'db'] } } },
            },
            { from: { element: { type: 'shared' } }, allow: { to: { element: { types: ['shared', 'config'] } } } },
            { from: { element: { type: 'app' } }, allow: { to: { element: { types: ['app', 'shared'] } } } },
          ],
        },
      ],
    },
  };
}

/**
 * No import cycles in any package (conventions §9, OVERVIEW §5, B-101): eslint-plugin-boundaries does not detect
 * cycles, so feature modules could otherwise form one through their index.ts.
 * @param {{ files: string[], tsconfigs: string[] }} options
 */
export function noImportCycles({ files, tsconfigs }) {
  return {
    files,
    plugins: { 'import-x': importX },
    settings: {
      // Without these, import-x only follows .js/.mjs/.cjs files and silently treats every .ts/.tsx module as
      // unknown, so no-cycle never reports a cycle between TypeScript files (values from importX.flatConfigs.typescript).
      'import-x/extensions': TS_AND_JS_EXTENSIONS,
      'import-x/external-module-folders': ['node_modules', 'node_modules/@types'],
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts', '.tsx', '.cts', '.mts'] },
      'import-x/resolver-next': [
        createTypeScriptImportResolver(typescriptResolverOptions(tsconfigs)),
        createNodeResolver({ conditionNames: NODE_RESOLVER_CONDITIONS }),
      ],
    },
    rules: {
      // import-x skips type-only imports (`import type`, `import { type X }`): they are erased at runtime.
      'import-x/no-cycle': ['error', { ignoreExternal: true }],
    },
  };
}

/**
 * Production code of the API never imports the test harness (ADR-0019 §3): apps/api/test holds the test-only sign-in
 * route, which would be an authentication bypass in the image. Applies to every file under apps/api/src except tests.
 * Flat config replaces a rule's options per file, so another `no-restricted-imports` block for the same files must
 * repeat this pattern.
 */
export const apiNoTestImports = {
  files: ['apps/api/src/**/*.ts'],
  ignores: ['apps/api/src/**/__tests__/**', 'apps/api/src/**/*.test.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            regex: '(^|/)test(/|$)',
            message: 'apps/api/test is the test harness; production code under src/ must never import it.',
          },
        ],
      },
    ],
  },
};

/**
 * Tests may assert presence with `!` after an explicit expectation.
 * @param {string[]} files
 */
export function testFileRules(files) {
  return { files, rules: { '@typescript-eslint/no-non-null-assertion': 'off' } };
}

export { prettier };
