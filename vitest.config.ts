import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{packages,services,simulator}/**/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
