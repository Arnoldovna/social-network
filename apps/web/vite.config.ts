import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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

export default defineConfig(() => {
  // `pnpm dev` starts the API with the repository's .env, so the proxy target reads PORT from the same file.
  // An empty `PORT=` means unset, as in the API's env loader. Nothing from .env reaches the bundle (no VITE_ keys).
  const configuredPort = configuredApiPort();
  const apiPort = configuredPort === undefined || configuredPort === '' ? '3000' : configuredPort;
  const apiTarget = `http://127.0.0.1:${apiPort}`;

  return {
    plugins: [react(), tailwindcss()],
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
      sourcemap: true,
      // Never inline assets (fonts, images) as data: URIs; the nginx CSP allows fonts from 'self' only.
      assetsInlineLimit: 0,
    },
  };
});
