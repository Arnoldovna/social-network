import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  // `pnpm dev` starts the API with the repository's .env, so the proxy target reads PORT from the same file.
  // An empty `PORT=` means unset, as in the API's env loader. Nothing from .env reaches the bundle (no VITE_ keys).
  const configuredPort = loadEnv(mode, REPO_ROOT, '')['PORT'];
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
