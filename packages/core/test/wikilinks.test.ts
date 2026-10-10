import { describe, expect, test } from 'vitest';
import type { SyntaxNode } from '@lezer/common';
import {
  BacklinkIndex,
  createNoteNameIndex,
  extractLinks,
  linkParser,
  normalizeWikiTarget,
  readWikilink,
  resolveNotePath,
  resolveWikilink,
  splitWikilink,
  startLinkExtraction,
  wikilinkCreatePath,
  wikilinkLabel,
  NOTE_LINKS_MAX,
  type LinkSource,
  type WikilinkInfo,
} from '../src';

/** Todos os nós `WikiLink` do texto, lidos como no editor/índice/exportação. */
function wikilinks(text: string) {
  const out: WikilinkInfo[] = [];
  linkParser.parse(text).iterate({
    enter: (ref) => {
      if (ref.name === 'WikiLink') out.push(readWikilink(ref.node as SyntaxNode, text));
    },
  });
  return out;
}

describe('AC-I2.1 parser (R-I2.1)', () => {
  test.each([
    ['[[alvo]]', { target: 'alvo', heading: null, alias: null }],
    ['[[alvo|apelido]]', { target: 'alvo', heading: null, alias: 'apelido' }],
    ['[[alvo#Título]]', { target: 'alvo', heading: 'Título', alias: null }],
    ['[[alvo#Título|apelido]]', { target: 'alvo', heading: 'Título', alias: 'apelido' }],
    ['[[#Título]]', { target: '', heading: 'Título', alias: null }],
    ['[[pasta/alvo]]', { target: 'pasta/alvo', heading: null, alias: null }],
    ['[[alvo.md]]', { target: 'alvo.md', heading: null, alias: null }],
    ['| c |\n| - |\n| [[alvo\\|apelido]] |', { target: 'alvo', heading: null, alias: 'apelido' }],
  ])('%s → nó WikiLink com alvo/título/apelido', (text, expected) => {
    const found = wikilinks(text);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject(expected);
  });

  test.each([
    ['código em linha', '`[[x]]`'],
    ['bloco de código', '```\n[[x]]\n```'],
    ['bloco recuado', '    [[x]]'],
    ['front matter', '---\ntitle: "[[x]]"\n---\ncorpo'],
    ['escapado', '\\[[x]]'],
    ['quebra de linha', '[[a\nb]]'],
    ['alvo de 1.001 caracteres', `[[${'a'.repeat(1001)}]]`],
    ['embed', '![[x]]'],
    ['vazio', '[[]]'],
    ['só espaços', '[[  ]]'],
    ['apelido vazio', '[[a|]]'],
  ])('%s não vira wikilink', (_label, text) => {
    expect(wikilinks(text)).toEqual([]);
  });

  test('alvo de 1.000 caracteres ainda é wikilink (borda)', () => {
    expect(wikilinks(`[[${'a'.repeat(1000)}]]`)).toHaveLength(1);
  });

  test('links markdown continuam sendo `Link` (sem regressão)', () => {
    const names: string[] = [];
    linkParser.parse('[t](a.md) [r][x] [[w]] <https://e.org>\n\n[x]: b.md').iterate({
      enter: (ref) => void names.push(ref.name),
    });
    expect(names.filter((n) => n === 'Link')).toHaveLength(2);
    expect(names.filter((n) => n === 'WikiLink')).toHaveLength(1);
    expect(names).toContain('Autolink');
  });

  // CR-S2-06: bordas do parser.
  test.each([
    ['código em linha que fecha depois de ]] tem precedência', '[[a `b]] c`', 0],
    ['crase sem par em lugar nenhum: wikilink', '[[a `b]] c', 1],
    ['código inteiro dentro do miolo: wikilink', '[[a `b` c]]', 1],
    ['crases de comprimentos diferentes: a de fora fecha depois', '[[a ``b` c]] d``', 0],
    ['! escapado antes de [[: wikilink', '\\![[x]]', 1],
    ['\\\\ + ! (barra escapada, ! real): embed, não é wikilink', '\\\\![[x]]', 0],
  ])('%s', (_label, text, count) => {
    expect(wikilinks(text)).toHaveLength(count);
  });

  test('splitWikilink e rótulo (apelido > alvo › Título > alvo)', () => {
    expect(splitWikilink('a#b|c')).toEqual({
      target: [0, 1],
      heading: [2, 3],
      pipe: [3, 4],
      alias: [4, 5],
    });
    expect(splitWikilink('a[b')).toBeNull();
    expect(wikilinkLabel({ target: 'Bolo', heading: 'Cobertura', alias: null })).toBe(
      'Bolo › Cobertura',
    );
    expect(wikilinkLabel({ target: 'Bolo', heading: null, alias: 'a receita' })).toBe('a receita');
    expect(wikilinkLabel({ target: '', heading: 'Wikilinks', alias: null })).toBe('Wikilinks');
    expect(wikilinkLabel({ target: 'Bolo', heading: null, alias: null })).toBe('Bolo');
  });
});

describe('AC-I2.2 resolução (≥ 20 casos; R-I2.3, D-37)', () => {
  const notes = createNoteNameIndex([
    'receitas/Bolo.md',
    'Pão.md',
    'Pao.md',
    'a/Nota.md',
    'b/Nota.md',
    'Nota.md',
    'x/y/Funda.md',
    'z/Funda.md',
    'm/Igual.md',
    'n/Igual.md',
    'Caixa/Alta.md',
    'caixa/alta.md',
    'imagem.png',
  ]);
  const ok = (target: string, from: string | null) => {
    const r = resolveWikilink(target, from, notes);
    return r.kind === 'resolved' ? r.path : `missing:${r.createPath}`;
  };

  test.each([
    ['única', 'Bolo', 'diario/x.md', 'receitas/Bolo.md'],
    ['caixa diferente', 'bolo', 'diario/x.md', 'receitas/Bolo.md'],
    ['caixa toda alta', 'BOLO', null, 'receitas/Bolo.md'],
    ['com espaços nas pontas', '  Bolo ', null, 'receitas/Bolo.md'],
    ['com .md', 'Bolo.md', null, 'receitas/Bolo.md'],
    ['com .MD', 'Bolo.MD', null, 'receitas/Bolo.md'],
    ['com /', 'receitas/Bolo', null, 'receitas/Bolo.md'],
    ['com / e .md', 'receitas/Bolo.md', null, 'receitas/Bolo.md'],
    ['com / e caixa', 'RECEITAS/bolo', null, 'receitas/Bolo.md'],
    ['com / inicial', '/receitas/Bolo', null, 'receitas/Bolo.md'],
    ['com / na pasta errada', 'outra/Bolo', 'receitas/x.md', 'missing:outra/Bolo.md'],
    ['acento significativo (Pão)', 'Pão', null, 'Pão.md'],
    ['acento significativo (Pao)', 'Pao', null, 'Pao.md'],
    ['NFD casa NFC', 'Pa\u0303o', null, 'Pão.md'],
    ['ambígua: mesma pasta (a)', 'Nota', 'a/vizinha.md', 'a/Nota.md'],
    ['ambígua: mesma pasta (b)', 'Nota', 'b/outra.md', 'b/Nota.md'],
    ['ambígua: mais curto (raiz)', 'Nota', 'c/x.md', 'Nota.md'],
    ['ambígua: menos pastas', 'Funda', 'q/x.md', 'z/Funda.md'],
    ['ambígua: alfabética pt-BR', 'Igual', null, 'm/Igual.md'],
    ['caixa no caminho: alfabética', 'caixa/alta', null, 'caixa/alta.md'],
    ['inexistente sem /', 'Nova ideia', 'Diário/hoje.md', 'missing:Diário/Nova ideia.md'],
    ['inexistente na raiz', 'Nova', 'raiz.md', 'missing:Nova.md'],
    ['inexistente com /', 'x/y/z', 'a/b.md', 'missing:x/y/z.md'],
    ['não-.md não conta', 'imagem', null, 'missing:imagem.md'],
    ['própria nota', '', 'a/b.md', 'a/b.md'],
  ])('%s: [[%s]] de %s → %s', (_label, target, from, expected) => {
    expect(ok(target, from)).toBe(expected);
  });

  test('ambígua devolve as outras (até 3) e o total', () => {
    const many = createNoteNameIndex(['a/N.md', 'b/N.md', 'c/N.md', 'd/N.md', 'e/N.md']);
    expect(resolveWikilink('N', 'a/x.md', many)).toEqual({
      kind: 'resolved',
      path: 'a/N.md',
      others: ['b/N.md', 'c/N.md', 'd/N.md'],
      otherCount: 4,
    });
    expect(resolveWikilink('', null, many)).toEqual({ kind: 'missing', createPath: '' });
  });

  test('empate pt-BR (mesmo nome em NFC e NFD) cai na ordem de bytes, em qualquer ordem de entrada', () => {
    const nfc = 'p/Caf\u00e9.md';
    const nfd = 'p/Cafe\u0301.md';
    for (const paths of [
      [nfc, nfd],
      [nfd, nfc],
    ]) {
      expect(resolveWikilink('Café', 'q/x.md', createNoteNameIndex(paths))).toMatchObject({
        path: nfd,
        others: [nfc],
      });
    }
  });

  test('normalização e caminho de criação', () => {
    expect(normalizeWikiTarget('  /a/b.MD ')).toBe('a/b');
    expect(wikilinkCreatePath('Nova', null)).toBe('Nova.md');
    expect(wikilinkCreatePath('Nova', 'p/q/r.md')).toBe('p/q/Nova.md');
    expect(wikilinkCreatePath('/Nova', 'p/q/r.md')).toBe('Nova.md');
  });

  test('1.000 resoluções ≤ 20 ms (NFR-46, orçamento do arch-backend §1.7.8)', () => {
    const big = createNoteNameIndex(
      Array.from({ length: 10_000 }, (_, i) => `p${i % 100}/nota-${i}.md`),
    );
    const start = performance.now();
    for (let i = 0; i < 1000; i++) resolveWikilink(`nota-${i * 7}`, 'p1/x.md', big);
    expect(performance.now() - start).toBeLessThan(20 * (process.env.CI ? 5 : 1));
  });
});

describe('extração de links para o índice (R-I2.8)', () => {
  const text = [
    '---',
    'title: "[[nao]]"',
    '---',
    '# T',
    'Veja [[Bolo#Cobertura|a cobertura]] e [rel](../b/c.md#x) e [ref][r].',
    '`[[codigo]]` [[#Local]] ![img](i.png) [ext](https://e.org) [pdf](a.pdf)',
    '',
    '[r]: outra.md',
  ].join('\r\n');

  test('posições 0-based UTF-16 no texto do editor; alvo cru do wikilink; .md resolvido', () => {
    expect(extractLinks(`\uFEFF${text}`, 'notas/n.md')).toEqual({
      truncated: false,
      links: [
        { line: 4, column: 5, length: 30, kind: 'wikilink', target: 'Bolo' },
        { line: 4, column: 38, length: 18, kind: 'inline', target: 'b/c.md' },
        { line: 4, column: 59, length: 8, kind: 'reference', target: 'notas/outra.md' },
      ],
    });
  });

  test('teto de 1.000: 1.001 links → 1.000 + truncated', () => {
    const many = Array.from({ length: NOTE_LINKS_MAX + 1 }, (_, i) => `[[n${i}]]`).join(' ');
    const result = extractLinks(many, 'a.md');
    expect(result.links).toHaveLength(NOTE_LINKS_MAX);
    expect(result.truncated).toBe(true);
    expect(extractLinks(many.slice(0, many.lastIndexOf(' ')), 'a.md').truncated).toBe(false);
  });

  test('trabalho fatiado: orçamento 0 cede a vez e termina com o mesmo resultado', () => {
    const doc = Array.from({ length: 3000 }, (_, i) => `linha ${i} [[n${i % 50}]]`).join('\n\n');
    const job = startLinkExtraction(doc, 'a.md');
    let steps = 0;
    while (!job.step(0)) steps++;
    expect(steps).toBeGreaterThan(0);
    expect(job.step(0)).toBe(true);
    expect(job.result()).toEqual(extractLinks(doc, 'a.md'));
  });

  test('sem `[[`, `](` nem `]:` a nota não é analisada (0 passos de parse) e não tem links', () => {
    const job = startLinkExtraction(
      '# Só texto [colchete] e (parênteses)\n\n[r] sem definição\n',
      'a.md',
    );
    expect(job.step(0)).toBe(true);
    expect(job.result()).toEqual({ links: [], truncated: false });
  });

  test.each([
    ['wikilink', 'x [[b]]', 'b'],
    ['em linha', 'x [t](b.md)', 'b.md'],
    ['referência atalho com definição', 'x [r]\n\n[r]: b.md', 'b.md'],
    ['referência completa', 'x [t][r]\n\n[r]: <b.md>', 'b.md'],
  ])('o pré-filtro não perde link: %s', (_label, text, target) => {
    expect(extractLinks(text, 'a.md').links.map((l) => l.target)).toEqual([target]);
  });
});

describe('índice reverso (R-I2.7, D-39)', () => {
  const link = (line: number, kind: 'wikilink' | 'inline' | 'reference', target: string) => ({
    line,
    column: 0,
    length: 3,
    kind,
    target,
  });
  const sources: LinkSource[] = [
    { path: 'alvo.md', title: 'Alvo', links: [link(0, 'wikilink', 'Alvo')] },
    {
      path: 'z.md',
      title: 'Zebra',
      links: [link(2, 'wikilink', 'alvo'), link(1, 'inline', 'alvo.md')],
    },
    { path: 'a.md', title: 'Ábaco', links: [link(0, 'reference', 'alvo.md')] },
    {
      path: 'b.md',
      title: 'Beta',
      links: [link(0, 'wikilink', 'Outro'), link(0, 'inline', 'falta.md')],
    },
  ];

  test('origens por título pt-BR, contagens, a própria nota fora, ocorrências em ordem', () => {
    const index = new BacklinkIndex();
    const notes = createNoteNameIndex(sources.map((s) => s.path));
    index.update(sources, notes);
    const result = index.backlinks('alvo.md');
    expect(result.links).toBe(3);
    expect(result.groups.map((g) => [g.path, g.occurrences.map((o) => o.line)])).toEqual([
      ['a.md', [0]],
      ['z.md', [1, 2]],
    ]);
    expect(index.backlinks('nenhum.md')).toEqual({ groups: [], links: 0 });
  });

  test('atualização por origem: link removido some; nota apagada sai; conjunto novo resolve de novo', () => {
    const index = new BacklinkIndex();
    let notes = createNoteNameIndex(sources.map((s) => s.path));
    index.update(sources, notes);
    const changed = sources.map((s) => (s.path === 'z.md' ? { ...s, links: [] } : s));
    index.update(changed, notes);
    expect(index.backlinks('alvo.md').groups.map((g) => g.path)).toEqual(['a.md']);
    index.update(
      changed.filter((s) => s.path !== 'a.md'),
      notes,
    );
    expect(index.backlinks('alvo.md').links).toBe(0);
    notes = createNoteNameIndex([...sources.map((s) => s.path), 'Outro.md']);
    index.update(sources, notes);
    expect(index.backlinks('Outro.md').groups.map((g) => g.path)).toEqual(['b.md']);
  });

  test('CR-S2-04: link .md relativo conta sem caixa e em NFC, como o wikilink; o exato vence', () => {
    const notes = createNoteNameIndex(['Bolo.md', 'Pão.md', 'x/A.md', 'x/a.md']);
    expect(resolveNotePath('bolo.md', notes)).toBe('Bolo.md');
    expect(resolveNotePath('Pa\u0303o.md', notes)).toBe('Pão.md');
    expect(resolveNotePath('x/a.md', notes)).toBe('x/a.md');
    expect(resolveNotePath('X/a.md', notes)).toBe('x/A.md');
    expect(resolveNotePath('nada.md', notes)).toBeNull();
    const index = new BacklinkIndex();
    index.update([{ path: 'c.md', title: 'C', links: [link(0, 'inline', 'bolo.md')] }], notes);
    expect(index.backlinks('Bolo.md').groups.map((g) => g.path)).toEqual(['c.md']);
  });
});
