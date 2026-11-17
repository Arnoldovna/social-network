// Schibsted Grotesk (SIL OFL 1.1), self-hosted via fontsource: static weights 400 and 500 only
// (maw-design-system §2, ADR-0015). Fonts first, then the entry stylesheet, so the cascade order is fixed.
import '@fontsource/schibsted-grotesk/400.css';
import '@fontsource/schibsted-grotesk/500.css';
import './styles/main.css';

import { setupListeners } from '@reduxjs/toolkit/query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { RouterProvider } from 'react-router/dom';

import { startRealtimeListener } from './app/realtime-listener';
import { createAppRouter } from './app/router';
import { startSessionListener } from './app/session-listener';
import { createAppStore } from './app/store';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('index.html has no #root element to mount the app into.');
}

// One store and one data router per tab (ADR-0012, ADR-0013). The listeners are registered before the router's first
// navigation can finish, so the `getMe` of the first loader already connects the socket.
const store = createAppStore();
setupListeners(store.dispatch);
startRealtimeListener(store);
const router = createAppRouter(store);
// Navigation is injected here, so the store never imports the router (no import cycle, B-101).
startSessionListener(store, (to, options) => router.navigate(to, options));

// createRoot (B-141): function components and hooks only.
createRoot(rootElement).render(
  <StrictMode>
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>
  </StrictMode>,
);
