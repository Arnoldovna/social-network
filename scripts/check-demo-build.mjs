// `pnpm check:demo-build` (ADR-0020): proves that the two web builds stay apart.
//   apps/web/dist       the production build (nginx image): no msw, no service worker, no demo code
//   apps/web/dist-demo  the GitHub Pages demo: the msw worker, 404.html (SPA fallback) and the Pages base path
// Run after `pnpm build` and `pnpm build:demo`. Exit code 1 with every problem listed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WEB = resolve(import.meta.dirname, '..', 'apps', 'web');
const PROD = join(WEB, 'dist');
const DEMO = join(WEB, 'dist-demo');
const BASE = '/social-network/';
const WORKER = 'mockServiceWorker.js';

/** Strings that only msw or the demo put into a bundle. */
const DEMO_MARKERS = ['mockServiceWorker', '[MSW]', 'demo-banner', 'Daten bleiben nur in deinem Browser'];

/** @param {string} dir @returns {string[]} */
function filesBelow(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

const problems = [];

for (const dir of [PROD, DEMO]) {
  if (!existsSync(join(dir, 'index.html'))) problems.push(`${dir}/index.html is missing: build both first`);
}

if (problems.length === 0) {
  if (existsSync(join(PROD, WORKER))) problems.push(`dist contains ${WORKER}`);
  for (const file of filesBelow(PROD).filter((path) => /\.(js|html|css)$/.test(path))) {
    const text = readFileSync(file, 'utf8');
    for (const marker of DEMO_MARKERS) {
      if (text.includes(marker)) problems.push(`${file} contains "${marker}" (demo code in the production build)`);
    }
  }

  if (!existsSync(join(DEMO, WORKER))) problems.push(`dist-demo has no ${WORKER}`);
  const index = readFileSync(join(DEMO, 'index.html'), 'utf8');
  if (!existsSync(join(DEMO, '404.html'))) {
    problems.push('dist-demo has no 404.html (GitHub Pages SPA fallback)');
  } else if (readFileSync(join(DEMO, '404.html'), 'utf8') !== index) {
    problems.push('dist-demo/404.html differs from index.html');
  }
  if (!index.includes(`src="${BASE}assets/`)) problems.push(`dist-demo/index.html does not load assets from ${BASE}`);
  const demoScripts = filesBelow(DEMO).filter((path) => path.endsWith('.js') && !path.endsWith(WORKER));
  if (!demoScripts.some((file) => readFileSync(file, 'utf8').includes('demo-banner'))) {
    problems.push('dist-demo contains no demo code');
  }
}

if (problems.length > 0) {
  console.error(`check-demo-build: ${String(problems.length)} problem(s)\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(
  'check-demo-build: OK (dist has no msw or demo code; dist-demo has the worker, 404.html and the base path)',
);
