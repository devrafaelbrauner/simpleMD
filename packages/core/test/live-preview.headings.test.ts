import { describe, expect, it } from 'vitest';
import { decosIn, previewState } from './helpers/live-preview';
import fixture from './fixtures/live-preview.md?raw';

const headingLines = fixture
  .split('\n')
  .map((line, i) => ({ line, number: i + 1 }))
  .filter(({ line }) => /^#{1,6} /.test(line));

describe('títulos (AC-3.2)', () => {
  it('a fixture tem os 6 níveis', () => {
    expect(headingLines).toHaveLength(6);
  });

  it.each(headingLines)(
    'cursor fora: linha $number tem cm-md-hN e "#…# " escondido',
    ({ number }) => {
      const state = previewState(fixture);
      const line = state.doc.line(number);
      const level = /^#+/.exec(line.text)![0].length;
      const decos = decosIn(state, line.from, line.to);
      expect(decos).toContainEqual({
        from: line.from,
        to: line.from,
        kind: 'line',
        class: `cm-md-h${level}`,
      });
      expect(decos.filter((d) => d.kind === 'replace')).toEqual([
        { from: line.from, to: line.from + level + 1, kind: 'replace' },
      ]);
    },
  );

  it.each(headingLines)(
    'cursor na linha $number: 0 substituições, classe mantida',
    ({ number }) => {
      const probe = previewState(fixture);
      const line = probe.doc.line(number);
      for (const anchor of [line.from, line.from + 2, line.to]) {
        const decos = decosIn(previewState(fixture, { anchor }), line.from, line.to);
        expect(decos.filter((d) => d.kind === 'replace' || d.kind === 'widget')).toEqual([]);
        expect(decos.some((d) => d.kind === 'line' && d.class?.startsWith('cm-md-h'))).toBe(true);
      }
    },
  );

  it('seleção que cruza a linha também revela', () => {
    const doc = 'texto\n# Título\nfim';
    const state = previewState(doc, { anchor: 2, head: doc.length });
    expect(decosIn(state, 6, 14).filter((d) => d.kind === 'replace')).toEqual([]);
  });

  it('sem foco (F-2): o cursor na linha não revela', () => {
    const state = previewState('# Título\n\ntexto', { anchor: 0, focus: false });
    expect(decosIn(state, 0, 8).filter((d) => d.kind === 'replace')).toEqual([
      { from: 0, to: 2, kind: 'replace' },
    ]);
  });

  it('título fechado "# a #" esconde as duas marcas', () => {
    const state = previewState('# a #\n\nx');
    expect(decosIn(state, 0, 5).filter((d) => d.kind === 'replace')).toEqual([
      { from: 0, to: 2, kind: 'replace' },
      { from: 3, to: 5, kind: 'replace' },
    ]);
  });

  it('título setext fica cru', () => {
    const state = previewState('Título\n===\n\nx');
    expect(decosIn(state, 0, 10)).toEqual([]);
  });
});
