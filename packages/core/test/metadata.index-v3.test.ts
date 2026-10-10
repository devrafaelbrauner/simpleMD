import { describe, expect, it } from 'vitest';
import { createNoteExtractor } from '../src';
import { indexProperties, startNoteIndexJob, type NoteIndexData } from '../src/metadata/note';

const run = (text: string, path = 'notas/a.md', budget = Number.POSITIVE_INFINITY): NoteIndexData => {
  const job = startNoteIndexJob(text, path);
  let steps = 0;
  while (!job.step(budget)) steps++;
  void steps;
  return job.result();
};

describe('índice v3 — tarefas pela árvore do editor (R-I9.3; arch-backend r7 §1.7.5)', () => {
  it('tarefas do corpo com a linha; fora de código e do front matter', () => {
    const text = [
      '---', // 0
      'status: ativo',
      '- [ ] no front matter',
      '---',
      '# Tarefas', // 4
      '- [ ] a 📅 2026-10-12 #casa', // 5
      '',
      '```',
      '- [ ] no código', // 8
      '```',
      '    - [ ] bloco indentado é código', // 10
      '',
      '1. [x] b ✅ 2026-10-01', // 12
      '> - [/] c', // 13
      '- - [ ] d', // 14
      '[ ] não é item', // 15
    ].join('\n');
    const { tasks } = run(text);
    expect(tasks.map((t) => [t.line, t.status, t.text])).toEqual([
      [5, ' ', 'a #casa'],
      [12, 'x', 'b'],
      [13, '/', 'c'],
      [14, ' ', 'd'],
    ]);
    expect(tasks[0]?.due).toBe('2026-10-12');
    expect(tasks[0]?.tags).toEqual(['#casa']);
  });

  it('CRLF e BOM: linhas do texto do editor', () => {
    const { tasks } = run('\uFEFF# T\r\n\r\n- [ ] a\r\n- [x] b\r\n');
    expect(tasks.map((t) => [t.line, t.text])).toEqual([
      [2, 'a'],
      [3, 'b'],
    ]);
  });

  it('2.001 tarefas → 2.000 + trunc "tasks"', () => {
    const text = Array.from({ length: 2001 }, (_, i) => `- [ ] t${i}`).join('\n');
    const data = run(text);
    expect(data.tasks).toHaveLength(2000);
    expect(data.tasks.at(-1)?.text).toBe('t1999');
    expect(data.truncated).toEqual(['tasks']);
  });

  it('trabalho em fatias (orçamento 0) = extração inteira', () => {
    const text = Array.from(
      { length: 400 },
      (_, i) => `- [ ] tarefa ${i} [[nota${i}]] #t${i % 7}\n\nparágrafo ${i}\n`,
    ).join('\n');
    const sliced = run(text, 'a.md', 0);
    const whole = run(text);
    expect(sliced).toEqual(whole);
    expect(whole.tasks).toHaveLength(400);
    expect(whole.links).toHaveLength(400);
    expect(whole.inlineTags).toHaveLength(7);
  });

  it('sem tarefa nem tag nem link: nada a analisar', () => {
    expect(run('# Título\n\ntexto simples\n')).toEqual({
      links: [],
      tasks: [],
      properties: {},
      inlineTags: [],
      truncated: [],
    });
  });

  it('createNoteExtractor usa o mesmo trabalho', () => {
    const job = createNoteExtractor().start('- [ ] x', 'a.md');
    while (!job.step(8));
    expect(job.result().tasks).toHaveLength(1);
  });
});

describe('índice v3 — tags do corpo (itags)', () => {
  it('fora de código, links, HTML e front matter; sem repetição; com #', () => {
    const text = [
      '---',
      'tags: [fm]',
      'x: "#nofm"',
      '---',
      '# Título #titulo',
      'Texto #ideia e #ideia de novo, #projeto/sub.',
      '`#codigo` e [rótulo #link](a.md) e [[nota#seção]] e <span title="#html">x</span>',
      '```',
      '#cerca',
      '```',
      'http://x.com/#ancora a#colado',
      '- [ ] tarefa #tarefa',
    ].join('\n');
    expect(run(text).inlineTags).toEqual(['#titulo', '#ideia', '#projeto/sub', '#tarefa']);
  });

  it('mais de 100 tags → 100 + trunc "itags"; tag > 200 caracteres sai', () => {
    const many = Array.from({ length: 105 }, (_, i) => `#t${i}`).join(' ');
    const data = run(`${many} #${'x'.repeat(250)}`);
    expect(data.inlineTags).toHaveLength(100);
    expect(data.truncated).toEqual(['itags']);
  });
});

describe('índice v3 — propriedades do front matter (R-I9.3)', () => {
  it('escalares, listas, objeto aninhado como JSON, objeto sem protótipo', () => {
    const { properties, truncated } = indexProperties(
      [
        '---',
        'tipo: projeto',
        'n: [1, 2]',
        'feito: true',
        'nada:',
        'nota: 3.5',
        'meta: {a: 1}',
        'mista: [a, {b: 2}]',
        '__proto__: dado',
        'constructor: outro',
        '---',
        'corpo',
      ].join('\n'),
    );
    expect(truncated).toBe(false);
    expect(Object.getPrototypeOf(properties)).toBeNull();
    expect({ ...properties }).toEqual({
      tipo: 'projeto',
      n: [1, 2],
      feito: true,
      nada: null,
      nota: 3.5,
      meta: '{"a":1}',
      mista: '["a",{"b":2}]',
      ['__proto__']: 'dado',
      constructor: 'outro',
    });
    expect(Object.prototype.hasOwnProperty.call(properties, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).dado).toBeUndefined();
  });

  it('101 chaves → 100 + trunc; chave > 200 pulada; valor > 1 KiB cortado', () => {
    const keys = Array.from({ length: 101 }, (_, i) => `k${i}: v`);
    const a = indexProperties(`---\n${keys.join('\n')}\n---\n`);
    expect(Object.keys(a.properties)).toHaveLength(100);
    expect(a.truncated).toBe(true);

    const b = indexProperties(`---\n${'k'.repeat(201)}: v\nok: v\n---\n`);
    expect(Object.keys(b.properties)).toEqual(['ok']);
    expect(b.truncated).toBe(true);

    const c = indexProperties(`---\nlongo: ${'é'.repeat(800)}\nlista: [${Array(300).fill('abcd').join(', ')}]\n---\n`);
    const longo = c.properties.longo as string;
    expect(new TextEncoder().encode(JSON.stringify(longo)).length).toBeLessThanOrEqual(1024);
    expect(longo.length).toBeGreaterThan(400);
    const lista = c.properties.lista as string[];
    expect(new TextEncoder().encode(JSON.stringify(lista)).length).toBeLessThanOrEqual(1024);
    expect(lista.length).toBeGreaterThan(100);
    expect(c.truncated).toBe(true);
  });

  it('front matter inválido ou ausente → nenhuma propriedade', () => {
    expect(Object.keys(indexProperties('---\n: :\n  - [\n---\n').properties)).toEqual([]);
    expect(Object.keys(indexProperties('sem front matter').properties)).toEqual([]);
  });

  it('entram no trabalho do índice (trunc "props" junto)', () => {
    const keys = Array.from({ length: 101 }, (_, i) => `k${i}: v`).join('\n');
    const data = run(`---\n${keys}\n---\n- [ ] a\n`);
    expect(Object.keys(data.properties)).toHaveLength(100);
    expect(data.truncated).toEqual(['props']);
  });
});
