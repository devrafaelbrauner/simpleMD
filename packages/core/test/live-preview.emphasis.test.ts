import { describe, expect, it } from 'vitest';
import { decosIn, previewState } from './helpers/live-preview';
import fixture from './fixtures/live-preview.md?raw';

const cases = [
  { source: '**negrito com asteriscos**', marker: 2, cls: 'cm-md-strong' },
  { source: '__negrito com sublinhados__', marker: 2, cls: 'cm-md-strong' },
  { source: '*itálico com asterisco*', marker: 1, cls: 'cm-md-em' },
  { source: '_itálico com sublinhado_', marker: 1, cls: 'cm-md-em' },
];

describe('ênfase e negrito (AC-3.3)', () => {
  it.each(cases)('cursor fora: marcadores de $source escondidos e conteúdo $cls', (c) => {
    const from = fixture.indexOf(c.source);
    const to = from + c.source.length;
    const decos = decosIn(previewState(fixture), from, to);
    expect(decos).toEqual([
      { from, to: from + c.marker, kind: 'replace' },
      { from: from + c.marker, to: to - c.marker, kind: 'mark', class: c.cls },
      { from: to - c.marker, to, kind: 'replace' },
    ]);
  });

  it.each(cases)('cursor dentro de $source: 0 substituições no nó', (c) => {
    const from = fixture.indexOf(c.source);
    const to = from + c.source.length;
    for (const anchor of [from, from + c.marker + 1, to]) {
      const decos = decosIn(previewState(fixture, { anchor }), from, to);
      expect(decos).toEqual([]);
    }
  });

  it('a revelação é por nó: o vizinho na mesma linha continua renderizado', () => {
    const doc = '**a** e *b*';
    const decos = decosIn(previewState(doc, { anchor: 2 }), 0, doc.length);
    expect(decos).toEqual([
      { from: 8, to: 9, kind: 'replace' },
      { from: 9, to: 10, kind: 'mark', class: 'cm-md-em' },
      { from: 10, to: 11, kind: 'replace' },
    ]);
  });

  it('sem foco (F-2): cursor dentro não revela', () => {
    const decos = decosIn(previewState('**a**', { anchor: 2, focus: false }), 0, 5);
    expect(decos.filter((d) => d.kind === 'replace')).toHaveLength(2);
  });

  it('ênfase que atravessa linhas: marcadores escondidos sem substituir a quebra', () => {
    const doc = '*um\ndois*';
    const decos = decosIn(previewState(doc, { anchor: 0, focus: false }), 0, doc.length);
    expect(decos.filter((d) => d.kind === 'replace')).toEqual([
      { from: 0, to: 1, kind: 'replace' },
      { from: 8, to: 9, kind: 'replace' },
    ]);
  });
});
