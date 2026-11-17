// Schibsted Grotesk (SIL OFL 1.1), self-hosted via fontsource: static weights 400 and 500 only
// (maw-design-system §2, ADR-0015). Fonts first, then the entry stylesheet, so the cascade order is fixed.
import '@fontsource/schibsted-grotesk/400.css';
import '@fontsource/schibsted-grotesk/500.css';
import './styles/main.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Phase 1a skeleton: one placeholder page, styled by the element defaults in styles/base.css only, so the web image
// builds and the e2e smoke test has a real document to load. Phase 1c replaces the body of this file with the store,
// the session and realtime listeners and <RouterProvider> (OVERVIEW, web tree).
const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('index.html has no #root element to mount the app into.');
}

createRoot(rootElement).render(
  <StrictMode>
    <main>
      <h1>let's chat</h1>
      <p>A small social network for profiles, friends, walls and real-time chat. This build is the skeleton.</p>
    </main>
  </StrictMode>,
);
