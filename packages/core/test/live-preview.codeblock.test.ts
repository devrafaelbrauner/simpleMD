import { describe, expect, it } from 'vitest';
import { decosIn, previewState } from './helpers/live-preview';
import fixture from './fixtures/live-preview.md?raw';

const from = fixture.indexOf('```ts');
const to = fixture.indexOf('```', from + 3) + 3;
const lineStarts = [
  from,
  ...[...fixture.slice(from, to).matchAll(/\n/g)].map((m) => from + m.index + 1),
];

describe('blocos de código cercados (AC-3.6)', () => {
  it('cursor fora: toda linha tem cm-md-codeblock e as cercas/linguagem ficam atenuadas', () => {
    const decos = decosIn(previewState(fixture), from, to);
    expect(lineStarts).toHaveLength(4);
    expect(decos.filter((d) => d.kind === 'line')).toEqual(
      lineStarts.map((start) => ({
        from: start,
        to: start,
        kind: 'line',
        class: 'cm-md-codeblock',
      })),
    );
    expect(decos.filter((d) => d.kind === 'mark')).toEqual([
      { from, to: from + 3, kind: 'mark', class: 'cm-md-fence-dim' },
      { from: from + 3, to: from + 5, kind: 'mark', class: 'cm-md-fence-dim' },
      { from: to - 3, to, kind: 'mark', class: 'cm-md-fence-dim' },
    ]);
  });

  it('**x** dentro do bloco: 0 decorações de ênfase ou substituição', () => {
    for (const focus of [true, false]) {
      const decos = decosIn(previewState(fixture, { focus }), from, to);
      expect(decos.filter((d) => d.kind === 'replace' || d.kind === 'widget')).toEqual([]);
      expect(decos.some((d) => d.class === 'cm-md-strong' || d.class === 'cm-md-em')).toBe(false);
    }
  });

  it('cursor dentro do bloco: classes de linha mantidas, cercas sem atenuação', () => {
    for (const anchor of [from, from + 10, to]) {
      const decos = decosIn(previewState(fixture, { anchor }), from, to);
      expect(decos.filter((d) => d.kind === 'line')).toHaveLength(4);
      expect(decos.filter((d) => d.class === 'cm-md-fence-dim')).toEqual([]);
    }
  });
});
