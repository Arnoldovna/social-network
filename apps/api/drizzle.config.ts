import { existsSync } from 'node:fs';

import { defineConfig } from 'drizzle-kit';

// `generate` works offline; `migrate`, `push` and `studio` need DATABASE_URL.
if (!process.env['DATABASE_URL'] && existsSync('../../.env')) process.loadEnvFile('../../.env');
const url = process.env['DATABASE_URL'];

// No `casing` option: every column names its SQL name explicitly (`text('first_name')`), so drizzle-kit never has to
// rewrite camelCase identifiers inside `sql` templates of checks and expression indexes (DATA-MODEL.md, Migrations).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  ...(url ? { dbCredentials: { url } } : {}),
  strict: true,
  verbose: true,
});
