import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./src/tests/setup.js'],
    include: ['src/tests/**/*.test.js'],
    // Clear mock state between each test so one test's mock doesn't bleed into another
    clearMocks: true,
    restoreMocks: true,
  },
});
