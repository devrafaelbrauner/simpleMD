import { describe, expect, it } from 'vitest';
import config from '../../../vitest.config';

type Limits = Record<string, { lines?: number; branches?: number }>;

/**
 * NFR-16/NFR-39 (TA-R2-2): a cobertura mínima só vale se o `vitest run --coverage` falhar abaixo
 * dela. Este teste prende os limites na configuração raiz, que é a que o CI (Ubuntu) usa.
 */
describe('limites de cobertura impostos (NFR-16, NFR-39)', () => {
  const thresholds = (config.test?.coverage as { thresholds?: Limits } | undefined)?.thresholds;

  it.each([
    ['packages/vault/src/**', 'lines'],
    ['packages/plugin-api/src/**', 'lines'],
    ['packages/ai/src/**', 'lines'],
  ] as const)('%s: %s ≥ 80%%', (glob, metric) => {
    expect(thresholds?.[glob]?.[metric]).toBeGreaterThanOrEqual(80);
  });

  it.each([
    ['packages/plugins-internal/src/calc/**', 'branches'],
    ['packages/core/src/metadata/yaml.ts', 'branches'],
  ] as const)('%s: %s ≥ 90%%', (glob, metric) => {
    expect(thresholds?.[glob]?.[metric]).toBeGreaterThanOrEqual(90);
  });
});
