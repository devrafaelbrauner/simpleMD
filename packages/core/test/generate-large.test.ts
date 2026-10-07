import { ensureSyntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { createMarkdownState } from '../src';
import { generateLargeMarkdown, generateRichMarkdown, RICH_COUNTS } from '../src/testing';

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

describe('generateRichMarkdown (rich-10k.md, NFR-21b)', () => {
  it('10.000 linhas, determinístico, com as contagens do product r2 §3', () => {
    const text = generateRichMarkdown();
    expect(text).toBe(generateRichMarkdown());
    expect(text.split('\n')).toHaveLength(RICH_COUNTS.lines);
    expect(text.match(/^```mermaid$/gm)).toHaveLength(RICH_COUNTS.mermaid);
    expect(text.match(/^\$\$$/gm)).toHaveLength(RICH_COUNTS.blockMath * 2);
    expect(text.match(/ =\d+\+\d+\*2$/gm)).toHaveLength(RICH_COUNTS.calc);
    expect(text.match(/\$[^$ ]+[^$]*?\$/g)?.length).toBeGreaterThanOrEqual(RICH_COUNTS.inlineMath);
    const state = createMarkdownState(text);
    const tree = ensureSyntaxTree(state, state.doc.length, 10_000);
    let tables = 0;
    for (let node = tree?.topNode.firstChild; node; node = node.nextSibling)
      if (node.name === 'Table') tables++;
    expect(tables).toBe(RICH_COUNTS.tables);
  });
});
