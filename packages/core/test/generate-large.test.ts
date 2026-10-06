import { describe, expect, it } from 'vitest';
import { generateLargeMarkdown } from '../src/testing';

describe('generateLargeMarkdown (NFR-5, demo ?doc=large)', () => {
  it('gera exatamente o número de linhas pedido', () => {
    expect(generateLargeMarkdown(10_000, 7).split('\n')).toHaveLength(10_000);
    expect(generateLargeMarkdown(3, 7).split('\n')).toHaveLength(3);
  });

  it('é determinístico para a mesma semente e muda com outra semente', () => {
    expect(generateLargeMarkdown(500, 42)).toBe(generateLargeMarkdown(500, 42));
    expect(generateLargeMarkdown(500, 42)).not.toBe(generateLargeMarkdown(500, 43));
  });

  it('10.000 linhas ficam na ordem de 400 KB e contêm os elementos do live preview', () => {
    const doc = generateLargeMarkdown(10_000, 1);
    const bytes = new TextEncoder().encode(doc).length;
    expect(bytes).toBeGreaterThan(250_000);
    expect(bytes).toBeLessThan(600_000);
    for (const marker of ['\n# ', '**', '](https://', '\n- ', '\n1. ', '\n```ts', '| :--- |']) {
      expect(doc).toContain(marker);
    }
  });
});
