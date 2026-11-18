/*
 * Entry of the GitHub Pages demo build (`pnpm build:demo`, ADR-0020); vite.config.ts points index.html here in the
 * `demo` mode only, so the production build never contains any of the demo or msw.
 *
 * The demo must be running before the app's modules load: engine.io-client keeps a reference to the global
 * `WebSocket` when its module is evaluated, and msw replaces that global when it starts. So the app's own entry is
 * imported only after `startDemo()` resolved.
 */
// The app's stylesheets first, in main.tsx's order: the demo banner's CSS shares a chunk with the app's components, and
// main.css must come first so it fixes the cascade layer order (base before components) for the whole page.
import '@fontsource/schibsted-grotesk/400.css';
import '@fontsource/schibsted-grotesk/500.css';
import '../styles/main.css';

import { showDemoUnavailable, startDemo } from './start-demo';

try {
  await startDemo();
  await import('../main');
} catch (error) {
  // eslint-disable-next-line no-console -- the demo has no server log; the browser console is where its failures can be diagnosed
  console.error('the demo could not start', error);
  showDemoUnavailable();
}
