import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { msw } from 'msw/vite';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

const REPO_ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));

/**
 * `PORT` from the process environment, else from the repository's .env (absent file = unset). Deliberately not Vite's
 * `loadEnv`: it copies the file's `NODE_ENV=development` into `VITE_USER_NODE_ENV` as a side effect, whatever the
 * prefix, and `vite build` then bundles development React.
 */
function configuredApiPort(): string | undefined {
  const fromProcess = process.env['PORT'];
  if (fromProcess !== undefined) return fromProcess;
  try {
    return parseEnv(readFileSync(REPO_ENV_FILE, 'utf8'))['PORT'];
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Where GitHub Pages serves the demo: https://arnoldovna.github.io/social-network/ (ADR-0020). */
const DEMO_BASE = '/social-network/';
const APP_ENTRY = '/src/main.tsx';
const DEMO_ENTRY = '/src/demo/entry.ts';

/**
 * The `demo` build's own wiring (ADR-0020): `index.html` loads the demo entry (which starts msw, then the app), and
 * `404.html` is a copy of it, because GitHub Pages answers every unknown path with that file (the SPA fallback).
 */
function demoEntry(): Plugin {
  return {
    name: 'social-network-demo-entry',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!html.includes(APP_ENTRY)) throw new Error(`index.html no longer loads ${APP_ENTRY}`);
        return html.replace(APP_ENTRY, DEMO_ENTRY);
      },
    },
    writeBundle(options) {
      if (options.dir !== undefined) copyFileSync(join(options.dir, 'index.html'), join(options.dir, '404.html'));
    },
  };
}

/**
 * Every other mode: the app's own sources may not import the demo or msw, so neither can reach the production bundle
 * (checked at the source here, and in the output by scripts/check-demo-build.mjs).
 */
function noDemoInApp(): Plugin {
  return {
    name: 'social-network-no-demo-in-app',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer === undefined || importer.includes('/node_modules/')) return null;
      if (source === 'msw' || source.startsWith('msw/') || /(^|\/)demo\//.test(source)) {
        this.error(`${importer} imports "${source}": the demo and msw belong to the demo build only (ADR-0020)`);
      }
      return null;
    },
  };
}

export default defineConfig(({ mode }) => {
  // `vite build --mode demo` (pnpm build:demo): the GitHub Pages demo with the API mocked in the browser. Every other
  // mode is the real app; it never references src/demo or msw (scripts/check-demo-build.mjs proves it).
  const demo = mode === 'demo';
  // `pnpm dev` starts the API with the repository's .env, so the proxy target reads PORT from the same file.
  // An empty `PORT=` means unset, as in the API's env loader. Nothing from .env reaches the bundle (no VITE_ keys).
  const configuredPort = configuredApiPort();
  const apiPort = configuredPort === undefined || configuredPort === '' ? '3000' : configuredPort;
  const apiTarget = `http://127.0.0.1:${apiPort}`;

  return {
    base: demo ? DEMO_BASE : '/',
    // msw's plugin in worker-only mode serves and emits mockServiceWorker.js under the base; src/demo starts the worker.
    plugins: [react(), tailwindcss(), ...(demo ? [msw({ mode: 'worker-only' }), demoEntry()] : [noDemoInApp()])],
    server: {
      port: 5173,
      strictPort: true,
      // Same origin in dev as in production (nginx proxies /api, /health and /socket.io), so cookies stay
      // SameSite=Lax and the socket handshake carries the dev origin from CORS_ORIGINS.
      proxy: {
        '/api': apiTarget,
        '/health': apiTarget,
        '/socket.io': { target: apiTarget, ws: true },
      },
    },
    build: {
      outDir: demo ? 'dist-demo' : 'dist',
      sourcemap: true,
      // Never inline assets (fonts, images) as data: URIs; the nginx CSP allows fonts from 'self' only.
      assetsInlineLimit: 0,
    },
  };
});
