import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'build/coverage',
      // apps/desktop/src entra só no relatório (CR-16); os limites valem só para NFR-16 e NFR-39.
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
        'packages/plugin-api/src/**': { lines: 80 }, // NFR-39 (API de plugins)
        'packages/ai/src/**': { lines: 80 }, // NFR-39 (camada de IA)
        'packages/plugins-internal/src/calc/**': { branches: 90 }, // NFR-39 (avaliador do calc)
        'packages/core/src/metadata/yaml.ts': { branches: 90 }, // NFR-39 (validador do front matter)
        'apps/desktop/src/plugins/internal/**': { lines: 80 }, // r7 NFR-59 (registro dos plugins internos, S0)
        'packages/vault/src/image-type.ts': { branches: 90 }, // NFR-59 (r7 SN, tipos de imagem)
      },
    },
  },
});
