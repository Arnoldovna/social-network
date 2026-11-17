/** @type {import('lint-staged').Configuration} */
export default {
  '*.{js,mjs,cjs,ts,mts,cts,tsx}': ['eslint --max-warnings=0 --fix', 'prettier --write'],
  '*.css': ['stylelint --fix', 'prettier --write'],
  '*.{json,md,yml,yaml,html}': ['prettier --write'],
  // The utility-class check needs every stylesheet of the app to know which classes exist, so it ignores the
  // staged file list and checks the whole web app whenever markup or CSS is staged.
  'apps/web/**/*.{tsx,html,css}': () => 'node scripts/check-no-utilities.mjs apps/web',
};
