import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    reporters: ['default'],
    sequence: { concurrent: false },
  },
  resolve: {
    alias: {
      '@lifementor/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
    },
  },
});
