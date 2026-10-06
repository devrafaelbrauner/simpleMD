import { describe, expect, it } from 'vitest';
import { BulletWidget } from '../src/live-preview/inline';
import { decosIn, previewState } from './helpers/live-preview';
import fixture from './fixtures/live-preview.md?raw';

function lineOf(text: string, needle: string): { from: number; to: number; text: string } {
  const start = text.indexOf(needle);
  const from = text.lastIndexOf('\n', start) + 1;
  const end = text.indexOf('\n', start);
  const to = end < 0 ? text.length : end;
  return { from, to, text: text.slice(from, to) };
}

describe('listas (AC-3.5)', () => {
  it.each(['- Item de lista', '  - Item aninhado', '  - Outro item aninhado', '- Segundo item'])(
    'cursor fora: o marcador de "%s" vira widget de 1 caractere, indentação intocada',
    (needle) => {
      const line = lineOf(fixture, needle);
      const indent = line.text.indexOf('-');
      const decos = decosIn(previewState(fixture), line.from, line.to);
      expect(decos).toHaveLength(1);
      const [deco] = decos;
      expect(deco).toMatchObject({
        from: line.from + indent,
        to: line.from + indent + 1,
        kind: 'widget',
      });
      expect(deco?.widget).toBeInstanceOf(BulletWidget);
      expect(deco?.block).toBe(false);
    },
  );

  it.each(['* estrela', '+ mais', '- [ ] tarefa'])('marcador "%s" também vira widget', (doc) => {
    const decos = decosIn(previewState(`x\n\n${doc}`, { anchor: 0 }), 3, 3 + doc.length);
    expect(decos).toEqual([expect.objectContaining({ from: 3, to: 4, kind: 'widget' })]);
  });

  it('cursor na linha: marcador cru (revelação pela linha inteira)', () => {
    const line = lineOf(fixture, '  - Item aninhado');
    const decos = decosIn(previewState(fixture, { anchor: line.to }), line.from, line.to);
    expect(decos).toEqual([]);
  });

  it.each(['1. Primeiro passo', '2. Segundo passo', '3. Terceiro passo'])(
    'número de "%s" continua texto, com cm-md-list-number',
    (needle) => {
      const line = lineOf(fixture, needle);
      expect(decosIn(previewState(fixture), line.from, line.to)).toEqual([
        { from: line.from, to: line.from + 2, kind: 'mark', class: 'cm-md-list-number' },
      ]);
    },
  );

  it('número na linha do cursor fica cru', () => {
    const line = lineOf(fixture, '2. Segundo passo');
    expect(decosIn(previewState(fixture, { anchor: line.from }), line.from, line.to)).toEqual([]);
  });
});
