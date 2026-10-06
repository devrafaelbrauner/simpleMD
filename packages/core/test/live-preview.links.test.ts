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

  it('link de referência, autolink, imagem e link sem texto ficam crus (A-6)', () => {
    const doc = '[r][x] <https://a.b> ![i](x.png) [](u)\n\n[x]: https://a.b';
    expect(decosIn(previewState(doc, { anchor: doc.length, focus: false }), 0, 38)).toEqual([]);
  });

  it('ênfase dentro do texto do link continua decorada', () => {
    const doc = '[**b**](u)';
    const decos = decosIn(previewState(doc, { anchor: 0, focus: false }), 0, doc.length);
    expect(decos).toContainEqual({ from: 1, to: 6, kind: 'mark', class: 'cm-md-link' });
    expect(decos).toContainEqual({ from: 3, to: 4, kind: 'mark', class: 'cm-md-strong' });
  });
});
