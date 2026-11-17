import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only unmounts automatically when the test framework exposes a global `afterEach`; Vitest runs
// without globals here, so every test file gets the cleanup explicitly. Rendered trees never leak into the next test.
afterEach(() => {
  cleanup();
});
