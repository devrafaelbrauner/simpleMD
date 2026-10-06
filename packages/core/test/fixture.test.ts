import { syntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { previewState } from './helpers/live-preview';
import fixture from './fixtures/live-preview.md?raw';

const state = previewState(fixture);
const text = (from: number, to: number) => state.doc.sliceString(from, to);

function nodes(name: string) {
  const found: { from: number; to: number; depth: number }[] = [];
  syntaxTree(state).iterate({
    enter: (ref) => {
      if (ref.name !== name) return;
      let depth = 0;
      for (let p = ref.node.parent; p; p = p.parent) if (p.name === name) depth++;
      found.push({ from: ref.from, to: ref.to, depth });
    },
  });
  return found;
}

describe('fixture live-preview.md (AC-3.1, R-3.4)', () => {
  it('tem títulos ATX h1–h6', () => {
    for (let level = 1; level <= 6; level++) expect(nodes(`ATXHeading${level}`)).toHaveLength(1);
  });

  it('tem negrito com ** e __ e itálico com * e _', () => {
    const strong = nodes('StrongEmphasis').map((n) => text(n.from, n.from + 2));
    const em = nodes('Emphasis').map((n) => text(n.from, n.from + 1));
    expect(strong).toEqual(expect.arrayContaining(['**', '__']));
    expect(em).toEqual(expect.arrayContaining(['*', '_']));
  });

  it('tem um link em linha [t](u)', () => {
    const links = nodes('Link').map((n) => text(n.from, n.to));
    expect(links.some((l) => /^\[[^\]]+\]\([^)]+\)$/.test(l))).toBe(true);
  });

  it('tem lista com marcadores aninhada em 2 níveis e uma lista ordenada', () => {
    expect(nodes('BulletList').some((n) => n.depth === 1)).toBe(true);
    expect(nodes('OrderedList').length).toBeGreaterThan(0);
  });

  it('tem bloco cercado com linguagem e **x** dentro', () => {
    const [code] = nodes('FencedCode');
    expect(code).toBeDefined();
    expect(nodes('CodeInfo')).toHaveLength(1);
    expect(text(code!.from, code!.to)).toContain('**x**');
  });

  it('tem tabela GFM de 3 colunas com linha de alinhamento', () => {
    const [table] = nodes('Table');
    expect(table).toBeDefined();
    const lines = text(table!.from, table!.to).split('\n');
    expect(lines[0]!.split('|').filter((c) => c.trim())).toHaveLength(3);
    expect(lines[1]).toMatch(/^\|\s*:-+\s*\|\s*:-+:\s*\|\s*-+:\s*\|$/);
  });
});
