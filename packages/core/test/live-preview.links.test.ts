import { describe, expect, it } from 'vitest';
import { decosIn, previewState } from './helpers/live-preview';
import fixture from './fixtures/live-preview.md?raw';

const LINK = '[site do CodeMirror](https://codemirror.net)';
const from = fixture.indexOf(LINK);
const to = from + LINK.length;
const textEnd = from + LINK.indexOf(']');

describe('links (AC-3.4)', () => {
  it('cursor fora: "[" e "](u)" escondidos, texto com cm-md-link', () => {
    expect(decosIn(previewState(fixture), from, to)).toEqual([
      { from, to: from + 1, kind: 'replace' },
      { from: from + 1, to: textEnd, kind: 'mark', class: 'cm-md-link' },
      { from: textEnd, to, kind: 'replace' },
    ]);
  });

  it('cursor dentro (texto, URL ou bordas): link cru', () => {
    for (const anchor of [from, from + 3, textEnd + 5, to]) {
      expect(decosIn(previewState(fixture, { anchor }), from, to)).toEqual([]);
    }
  });

  it('título do link também fica escondido', () => {
    const doc = 'a [t](u "dica") b';
    expect(decosIn(previewState(doc, { anchor: 0, focus: false }), 2, 15)).toEqual([
      { from: 2, to: 3, kind: 'replace' },
      { from: 3, to: 4, kind: 'mark', class: 'cm-md-link' },
      { from: 4, to: 15, kind: 'replace' },
    ]);
  });

  // RG-R7-2 (D-39, D-32): no r7, referência COM definição e autolink viram link e a imagem vira
  // widget (R-I1.1, R-I1.7); o link sem texto e a linha de definição continuam crus. Antes (A-6):
  // tudo cru.
  it('referência com definição e autolink viram link, imagem vira widget, link sem texto fica cru', () => {
    const doc = '[r][x] <https://a.b> ![i](x.png) [](u)\n\n[x]: https://a.b';
    const decos = decosIn(previewState(doc, { anchor: doc.length, focus: false }), 0, doc.length);
    expect(decos.map(({ from, to, kind, class: cls }) => ({ from, to, kind, cls }))).toEqual([
      { from: 0, to: 1, kind: 'replace', cls: undefined },
      { from: 1, to: 2, kind: 'mark', cls: 'cm-md-link' },
      { from: 2, to: 6, kind: 'replace', cls: undefined },
      { from: 7, to: 8, kind: 'replace', cls: undefined },
      { from: 8, to: 19, kind: 'mark', cls: 'cm-md-link' },
      { from: 19, to: 20, kind: 'replace', cls: undefined },
      { from: 21, to: 32, kind: 'widget', cls: undefined },
    ]);
  });

  it('referência sem definição fica crua nas 3 formas (R-I1.1)', () => {
    const doc = '[t][r] [t][] [t]';
    expect(decosIn(previewState(doc, { anchor: 0, focus: false }), 0, doc.length)).toEqual([]);
  });

  it('ênfase dentro do texto do link continua decorada', () => {
    const doc = '[**b**](u)';
    const decos = decosIn(previewState(doc, { anchor: 0, focus: false }), 0, doc.length);
    expect(decos).toContainEqual({ from: 1, to: 6, kind: 'mark', class: 'cm-md-link' });
    expect(decos).toContainEqual({ from: 3, to: 4, kind: 'mark', class: 'cm-md-strong' });
  });
});
