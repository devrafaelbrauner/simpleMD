import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'build/coverage',
      // apps/desktop/src entra só no relatório (CR-16); o limite continua só no vault.
      include: ['packages/*/src/**', 'apps/desktop/src/**'],
      // Só código: os `SOURCE.md` das fontes geravam PARSE_ERROR em toda execução (TA-5).
      exclude: [
        '**/testing/**',
        '**/*.test-d.ts',
        '**/*.md',
        '**/*.json',
        '**/*.woff2',
        '**/*.txt',
      ],
      thresholds: {
        'packages/vault/src/**': { lines: 80 }, // NFR-16
        'packages/plugins-internal/src/calc/**': { branches: 90 }, // NFR-39 (avaliador do calc)
      },
    },
  },
});
