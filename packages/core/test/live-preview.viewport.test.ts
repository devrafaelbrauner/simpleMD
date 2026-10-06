import { describe, expect, it } from 'vitest';
import { computeInlineDecorations } from '../src';
import { generateLargeMarkdown } from '../src/testing';
import { flattenDecos, previewState } from './helpers/live-preview';

describe('só as faixas visíveis são decoradas (R-3.3, base do NFR-5)', () => {
  const doc = generateLargeMarkdown(10_000, 1);
  const state = previewState(doc, { anchor: 0 });

  it('decorações em linha ficam dentro das linhas das faixas pedidas', () => {
    const a = { from: state.doc.line(4000).from, to: state.doc.line(4060).to };
    const b = { from: state.doc.line(7000).from, to: state.doc.line(7040).to };
    const decos = flattenDecos(computeInlineDecorations(state, [a, b]));
    expect(decos.length).toBeGreaterThan(0);
    const inside = (pos: number) =>
      [a, b].some((r) => pos >= state.doc.lineAt(r.from).from && pos <= state.doc.lineAt(r.to).to);
    expect(decos.filter((d) => !inside(d.from))).toEqual([]);
  });

  it('faixas vazias não produzem decorações em linha', () => {
    expect(computeInlineDecorations(state, []).size).toBe(0);
  });
});
