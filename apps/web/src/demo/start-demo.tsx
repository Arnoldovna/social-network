import { setupWorker } from 'msw/browser';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { DemoBackend } from './backend';
import { DemoBanner, DemoUnavailable } from './DemoBanner';
import { createHttpHandlers } from './http-handlers';
import { createIndexedDbPersistence } from './persistence';
import { createSocketHandler, DemoSocketServer } from './realtime';
import { loadOrSeed } from './seed';
import { startSimulation } from './simulation';
import { createSyncedPersistence } from './sync';

/** Width and height through the browser's own decoder; `null` when it cannot decode the file. */
async function measureImage(image: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(image);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

/** A container for the demo's own UI, before the app's root, so it is the first thing on the page and in the DOM. */
function demoRoot() {
  const container = document.createElement('div');
  container.className = 'demo-root';
  document.body.prepend(container);
  return createRoot(container);
}

function restart(): void {
  window.location.assign(import.meta.env.BASE_URL);
}

/**
 * Starts the GitHub Pages demo (ADR-0020) before the app loads: the stored state from IndexedDB (or a fresh seed),
 * the demo backend behind msw's HTTP handlers and the Socket.IO WebSocket link, the simulated people, the tab sync and
 * the demo banner. Resolves once the service worker controls the page, so the app's very first request is already
 * answered in the browser.
 */
export async function startDemo(): Promise<void> {
  const server = new DemoSocketServer();
  let backend: DemoBackend | null = null;
  const synced = createSyncedPersistence(
    await createIndexedDbPersistence(),
    'BroadcastChannel' in window ? new BroadcastChannel('social-network-demo') : null,
    { onRemoteState: (state) => backend?.adopt(state), onRemoteReset: restart },
  );
  const state = await loadOrSeed(synced.persistence, new Date());
  backend = new DemoBackend({ state, persistence: synced.persistence, realtime: server, measureImage });
  server.attach(backend);

  const worker = setupWorker(...createHttpHandlers(backend), createSocketHandler(server));
  await worker.start({
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    // Fonts, scripts and the app shell come from GitHub Pages as usual; only /api and /socket.io are answered here.
    onUnhandledFrame: 'bypass',
    quiet: true,
  });

  const stopSimulation = startSimulation({ backend, server });
  const reset = async () => {
    stopSimulation();
    await synced.reset();
    restart();
  };
  demoRoot().render(
    <StrictMode>
      <DemoBanner onReset={reset} />
    </StrictMode>,
  );
}

/** Shown instead of the app when the demo cannot start (no service workers or IndexedDB, e.g. private windows). */
export function showDemoUnavailable(): void {
  demoRoot().render(
    <StrictMode>
      <DemoUnavailable />
    </StrictMode>,
  );
}
