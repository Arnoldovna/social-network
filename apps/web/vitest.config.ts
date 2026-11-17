import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'unit:web',
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    // jest-dom matchers; Phase 1c adds the render and MSW helpers next to it (src/shared/test).
    setupFiles: ['./src/shared/test/setup.ts'],
    restoreMocks: true,
  },
});
