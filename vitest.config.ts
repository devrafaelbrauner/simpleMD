import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'build/coverage',
      include: ['packages/*/src/**'],
      exclude: ['**/testing/**', '**/*.test-d.ts'],
      thresholds: { 'packages/vault/src/**': { lines: 80 } }, // NFR-16
    },
  },
});
