import { describe, expect, it } from 'vitest';
import { JS_REFUSED, parseDataviewQuery, type DqlQuery } from '../src/tasks/query/dql-parser';

const ok = (source: string): DqlQuery => {
  const parsed = parseDataviewQuery(source);
  if (parsed.kind === 'error') throw new Error(parsed.message);
  return parsed;
};

const field = (...path: string[]) => ({ kind: 'field' as const, path });
const lit = (value: string | number | boolean | null) => ({ kind: 'literal' as const, value });

// AC-I9.4: ≥ 40 consultas aceitas do subconjunto, cada uma com a parte relevante da árvore.
const ACCEPTED: readonly [string, object][] = [
  ['LIST', { type: 'LIST', listExpr: null, from: null }],
  ['list', { type: 'LIST' }],
  ['TASK', { type: 'TASK' }],
  ['task', { type: 'TASK' }],
  ['TABLE', { type: 'TABLE', columns: [] }],
  ['LIST file.mtime', { listExpr: { expr: field('file', 'mtime'), label: 'file.mtime' } }],
  ['LIST autor', { listExpr: { expr: field('autor'), label: 'autor' } }],
  ['TABLE autor', { columns: [{ expr: field('autor'), label: 'autor' }] }],
  [
    'TABLE autor AS "Quem", file.size AS "Tamanho"',
    {
      columns: [
        { expr: field('autor'), label: 'Quem' },
        { expr: field('file', 'size'), label: 'Tamanho' },
      ],
    },
  ],
  ['TABLE file.name, file.path, file.folder', { columns: [
    { expr: field('file', 'name'), label: 'file.name' },
    { expr: field('file', 'path'), label: 'file.path' },
    { expr: field('file', 'folder'), label: 'file.folder' },
  ] }],
  ['TABLE file.tags AS Tags', { columns: [{ expr: field('file', 'tags'), label: 'Tags' }] }],
  ['LIST FROM #receita', { from: { kind: 'tag', tag: '#receita' } }],
  ['LIST FROM #casa/limpeza', { from: { kind: 'tag', tag: '#casa/limpeza' } }],
  ['LIST FROM "Projetos"', { from: { kind: 'folder', path: 'Projetos' } }],
  ['LIST FROM "Projetos/2026 Q4"', { from: { kind: 'folder', path: 'Projetos/2026 Q4' } }],
  ['LIST FROM [[Bolo]]', { from: { kind: 'link', target: 'Bolo' } }],
  ['LIST FROM [[Receitas/Bolo|o bolo]]', { from: { kind: 'link', target: 'Receitas/Bolo' } }],
  [
    'LIST FROM #a and "x"',
    { from: { kind: 'and', left: { kind: 'tag', tag: '#a' }, right: { kind: 'folder', path: 'x' } } },
  ],
  [
    'LIST FROM #a or #b',
    { from: { kind: 'or', left: { kind: 'tag', tag: '#a' }, right: { kind: 'tag', tag: '#b' } } },
  ],
  ['LIST FROM -#rascunho', { from: { kind: 'not', operand: { kind: 'tag', tag: '#rascunho' } } }],
  ['LIST FROM not "Arquivo"', { from: { kind: 'not', operand: { kind: 'folder', path: 'Arquivo' } } }],
  ['LIST FROM !#x', { from: { kind: 'not', operand: { kind: 'tag', tag: '#x' } } }],
  [
    'LIST FROM (#a or #b) and -"Lixo"',
    {
      from: {
        kind: 'and',
        left: { kind: 'or', left: { kind: 'tag', tag: '#a' }, right: { kind: 'tag', tag: '#b' } },
        right: { kind: 'not', operand: { kind: 'folder', path: 'Lixo' } },
      },
    },
  ],
  ['LIST WHERE autor = "Ana"', { where: [{ kind: 'compare', op: '=', left: field('autor'), right: lit('Ana') }] }],
  ['LIST WHERE nota != 3', { where: [{ kind: 'compare', op: '!=', left: field('nota'), right: lit(3) }] }],
  ['LIST WHERE nota < 3.5', { where: [{ kind: 'compare', op: '<', left: field('nota'), right: lit(3.5) }] }],
  ['LIST WHERE nota <= 3', { where: [{ kind: 'compare', op: '<=', left: field('nota'), right: lit(3) }] }],
  ['LIST WHERE file.size > 100', { where: [{ kind: 'compare', op: '>', left: field('file', 'size'), right: lit(100) }] }],
  ['LIST WHERE nota >= 1', { where: [{ kind: 'compare', op: '>=', left: field('nota'), right: lit(1) }] }],
  ['LIST WHERE publicado = true', { where: [{ kind: 'compare', op: '=', left: field('publicado'), right: lit(true) }] }],
  ['LIST WHERE capa = null', { where: [{ kind: 'compare', op: '=', left: field('capa'), right: lit(null) }] }],
  ['LIST WHERE publicado', { where: [field('publicado')] }],
  ['LIST WHERE !publicado', { where: [{ kind: 'not', operand: field('publicado') }] }],
  [
    'LIST WHERE a = 1 and b = 2 or c = 3',
    {
      where: [
        {
          kind: 'or',
          left: {
            kind: 'and',
            left: { kind: 'compare', op: '=', left: field('a'), right: lit(1) },
            right: { kind: 'compare', op: '=', left: field('b'), right: lit(2) },
          },
          right: { kind: 'compare', op: '=', left: field('c'), right: lit(3) },
        },
      ],
    },
  ],
  [
    'LIST WHERE a = 1 and (b = 2 or c = 3)',
    {
      where: [
        {
          kind: 'and',
          left: { kind: 'compare', op: '=', left: field('a'), right: lit(1) },
          right: {
            kind: 'or',
            left: { kind: 'compare', op: '=', left: field('b'), right: lit(2) },
            right: { kind: 'compare', op: '=', left: field('c'), right: lit(3) },
          },
        },
      ],
    },
  ],
  ['LIST WHERE contains(file.tags, "#casa")', { where: [{ kind: 'contains', haystack: field('file', 'tags'), needle: lit('#casa') }] }],
  ['LIST WHERE contains(file.name, "Bolo")', { where: [{ kind: 'contains', haystack: field('file', 'name'), needle: lit('Bolo') }] }],
  ['LIST WHERE file.mtime >= date(today)', { where: [{ kind: 'compare', op: '>=', left: field('file', 'mtime'), right: { kind: 'date', date: { offset: 0 } } }] }],
  ['LIST WHERE prazo < date(2026-10-12)', { where: [{ kind: 'compare', op: '<', left: field('prazo'), right: { kind: 'date', date: { date: '2026-10-12' } } }] }],
  ['LIST WHERE prazo < date("2026-10-12")', { where: [{ kind: 'compare', op: '<', left: field('prazo'), right: { kind: 'date', date: { date: '2026-10-12' } } }] }],
  ['TASK WHERE !completed', { type: 'TASK', where: [{ kind: 'not', operand: field('completed') }] }],
  ['TASK WHERE status = "/"', { where: [{ kind: 'compare', op: '=', left: field('status'), right: lit('/') }] }],
  ['TASK WHERE contains(text, "pão")', { where: [{ kind: 'contains', haystack: field('text'), needle: lit('pão') }] }],
  ['TASK WHERE due <= date(today) and !completed', { type: 'TASK' }],
  ['TASK WHERE scheduled = date(tomorrow) or start = date(yesterday)', { type: 'TASK' }],
  ['TASK WHERE done = date(today)', { type: 'TASK' }],
  ['TASK WHERE priority = "high"', { where: [{ kind: 'compare', op: '=', left: field('priority'), right: lit('high') }] }],
  ['TASK WHERE contains(tags, "#casa")', { type: 'TASK' }],
  ['LIST SORT file.name', { sort: [{ expr: field('file', 'name'), desc: false }] }],
  ['LIST SORT file.mtime DESC', { sort: [{ expr: field('file', 'mtime'), desc: true }] }],
  [
    'LIST SORT autor ASC, file.size desc',
    { sort: [{ expr: field('autor'), desc: false }, { expr: field('file', 'size'), desc: true }] },
  ],
  ['LIST GROUP BY autor', { groupBy: { expr: field('autor'), label: 'autor' } }],
  ['TASK GROUP BY file.folder', { groupBy: { expr: field('file', 'folder'), label: 'file.folder' } }],
  ['LIST LIMIT 10', { limit: 10 }],
  ['LIST LIMIT 1000', { limit: 1000 }],
  [
    'TABLE autor, nota AS "Nota"\nFROM "Livros"\nWHERE nota >= 4\nSORT nota DESC\nLIMIT 5',
    { type: 'TABLE', from: { kind: 'folder', path: 'Livros' }, limit: 5 },
  ],
  ['LIST\nWHERE a = 1\nWHERE b = 2', { where: [
    { kind: 'compare', op: '=', left: field('a'), right: lit(1) },
    { kind: 'compare', op: '=', left: field('b'), right: lit(2) },
  ] }],
  ['LIST WHERE título = "Olá \\"mundo\\""', { where: [{ kind: 'compare', op: '=', left: field('título'), right: lit('Olá "mundo"') }] }],
  ['LIST WHERE data-de-entrega = date(2026-01-01)', { where: [{ kind: 'compare', op: '=', left: field('data-de-entrega'), right: { kind: 'date', date: { date: '2026-01-01' } } }] }],
];

describe('parser dataview: consultas aceitas (AC-I9.4)', () => {
  it('tem ≥ 40 casos', () => expect(ACCEPTED.length).toBeGreaterThanOrEqual(40));
  it.each(ACCEPTED)('%s', (source, expected) => expect(ok(source)).toMatchObject(expected));
});

const unsupported = (construct: string, line: number) => ({
  kind: 'error',
  line,
  message: `Não suportado nas consultas do simpleMD: ${construct} (linha ${line}).`,
});

// AC-I9.4: ≥ 15 recusas que nomeiam a construção.
const REFUSED: readonly [string, object][] = [
  ['LIST\nFLATTEN file.tags', unsupported('FLATTEN', 2)],
  ['TABLE autor\nFROM "x"\nFLATTEN autor AS a', unsupported('FLATTEN', 3)],
  ['CALENDAR file.mtime', unsupported('CALENDAR', 1)],
  ['calendar due', unsupported('CALENDAR', 1)],
  ['TABLE WITHOUT ID autor', unsupported('WITHOUT ID', 1)],
  ['LIST WITHOUT ID file.name', unsupported('WITHOUT ID', 1)],
  ['LIST WHERE rating:: 5', unsupported('rating::', 1)],
  ['TASK\nWHERE estado:: "feito"', unsupported('estado::', 2)],
  ['LIST WHERE length(file.tags) > 1', unsupported('length()', 1)],
  ['LIST WHERE dateformat(file.mtime, "yyyy") = "2026"', unsupported('dateformat()', 1)],
  ['TABLE round(nota)', unsupported('round()', 1)],
  ['LIST FROM outgoing([[Bolo]])', unsupported('outgoing()', 1)],
  ['LIST WHERE nota + 1 > 2', unsupported('operador +', 1)],
  ['LIST WHERE nota - 1 > 2', unsupported('operador -', 1)],
  ['LIST WHERE file.ctime > date(today)', unsupported('file.ctime', 1)],
  ['LIST WHERE file.link = "x"', unsupported('file.link', 1)],
  ['LIST WHERE autor.nome = "Ana"', unsupported('autor.nome', 1)],
  ['LIST WHERE contains(file.outlinks, [[Bolo]])', unsupported('file.outlinks', 1)],
];

describe('parser dataview: construções recusadas pelo nome (AC-I9.4)', () => {
  it('tem ≥ 15 casos', () => expect(REFUSED.length).toBeGreaterThanOrEqual(15));
  it.each(REFUSED)('%s', (source, expected) => expect(parseDataviewQuery(source)).toEqual(expected));
});

describe('parser dataview: erros de sintaxe', () => {
  it.each([
    ['', 1],
    ['SELECT file', 1],
    ['LIST WHERE', 1],
    ['LIST\nWHERE a =', 2],
    ['LIST LIMIT 1001', 1],
    ['LIST LIMIT x', 1],
    ['LIST FROM "x" FROM "y"', 1],
    ['LIST WHERE a = "sem fim', 1],
    ['LIST FROM [[aberto', 1],
    ['LIST WHERE date(ontem) = a', 1],
    ['LIST WHERE contains(a) ', 1],
    ['LIST GROUP BY a GROUP BY b', 1],
    ['LIST WHERE a = 1.2.3', 1],
    ['LIST WHERE a = ;', 1],
  ])('%j → "Instrução não reconhecida na linha %i"', (source, line) => {
    const parsed = parseDataviewQuery(source);
    expect(parsed.kind).toBe('error');
    if (parsed.kind === 'error')
      expect(parsed.message).toMatch(new RegExp(`^Instrução não reconhecida na linha ${line}:`));
  });
});

describe('JavaScript nunca executa (AC-I9.4)', () => {
  it('$= no início do bloco → mensagem fixa', () => {
    expect(parseDataviewQuery('$= dv.pages().length')).toEqual({
      kind: 'error',
      line: 0,
      message: JS_REFUSED,
    });
    expect(parseDataviewQuery('LIST WHERE $= 1')).toMatchObject({ message: JS_REFUSED });
  });

  it('o parser não avalia texto: 0 execução de código mesmo com sintaxe de JS', () => {
    const marker = globalThis as { __dqlRan?: boolean };
    parseDataviewQuery('LIST WHERE contains(file.name, "x") = (globalThis.__dqlRan = true)');
    parseDataviewQuery('$= (globalThis.__dqlRan = true)');
    expect(marker.__dqlRan).toBeUndefined();
  });
});
