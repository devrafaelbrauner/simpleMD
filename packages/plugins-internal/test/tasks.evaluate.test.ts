import type { IndexedNote, IndexedTask } from '@simplemd/plugin-api/internal/tasks-catalog';
import { describe, expect, it } from 'vitest';
import {
  displayValue,
  evaluateDataview,
  runQuery,
  type QueryKind,
  type QueryResult,
  type QuerySource,
  type TaskRow,
} from '../src/tasks/query/evaluate';
import { parseDataviewQuery, type DqlQuery } from '../src/tasks/query/dql-parser';
import { fakeCatalog, fxR7Notes, fxR7Queries, indexNote } from './tasks-fixture';

const TODAY = '2026-10-10';
const notes = fxR7Notes();
const catalog = fakeCatalog(notes);
const source = (
  notePath = 'consultas.md',
  list: readonly IndexedNote[] = catalog.getSnapshot().notes,
): QuerySource => ({
  notes: list,
  catalog,
  notePath,
  today: TODAY,
});

interface Found {
  readonly path: string;
  readonly task: IndexedTask;
}
const allTasks: Found[] = catalog
  .getSnapshot()
  .notes.flatMap((note) => note.tasks.map((task) => ({ path: note.path, task })));
const key = (f: { path: string; task: IndexedTask }) => `${f.path}:${f.task.line}`;
const DONE = /^[xX-]$/;

function taskKeys(result: QueryResult): string[] {
  if (result.kind !== 'tasks') throw new Error(`esperava tarefas, veio ${result.kind}`);
  return result.groups.flatMap((g) => g.rows.map((row) => key(row.ref)));
}
function groupsOf(result: QueryResult): [string | null, string[]][] {
  if (result.kind !== 'tasks') throw new Error(result.kind);
  return result.groups.map((g) => [g.label, g.rows.map((row) => key(row.ref))]);
}
function noteRows(result: QueryResult): [string, readonly string[]][] {
  if (result.kind !== 'list' && result.kind !== 'table') throw new Error(result.kind);
  return result.groups.flatMap((g) =>
    g.rows.map((row) => [row.path, row.cells] as [string, readonly string[]]),
  );
}
const run = (kind: QueryKind, code: string, notePath?: string) =>
  runQuery(kind, code, source(notePath));

describe('vault FX-R7 indexado para os testes', () => {
  it('o índice tem as tarefas do fixture e 10 + 10 consultas de referência (+1 recusada de cada)', () => {
    expect(allTasks.length).toBeGreaterThanOrEqual(190);
    const queries = fxR7Queries();
    expect(queries.filter((q) => q.info === 'tasks').length).toBe(11);
    expect(queries.filter((q) => q.info === 'dataview').length).toBe(11);
  });
});

// AC-I9.5: as 20 consultas de referência de `consultas.md` (10 tasks + 10 dataview).
describe('AC-I9.5: 10 consultas tasks de referência', () => {
  const [q1, q2, q3, q4, q5, q6, q7, q8, q9, q10] = fxR7Queries().filter((q) => q.info === 'tasks');

  it('1 not done = complemento exato de done (partição das tarefas)', () => {
    const notDone = taskKeys(run('tasks', q1!.code));
    const done = taskKeys(run('tasks', q2!.code));
    expect(notDone).toEqual(allTasks.filter((f) => !DONE.test(f.task.status)).map(key));
    expect(done).toEqual(allTasks.filter((f) => DONE.test(f.task.status)).map(key));
    expect(notDone.length + done.length).toBe(allTasks.length);
  });

  it('3 not done + due before 2026-10-15 + sort by due', () => {
    const expected = allTasks
      .filter(
        (f) => !DONE.test(f.task.status) && f.task.due !== undefined && f.task.due < '2026-10-15',
      )
      .sort((a, b) => (a.task.due! < b.task.due! ? -1 : a.task.due! > b.task.due! ? 1 : 0));
    const got = taskKeys(run('tasks', q3!.code));
    expect(got).toEqual(expected.map(key));
    expect(got.length).toBeGreaterThan(5);
  });

  it('4 priority is high', () => {
    expect(taskKeys(run('tasks', q4!.code))).toEqual(
      allTasks.filter((f) => f.task.priority === 4).map(key),
    );
  });

  it('5 tags include #trabalho + group by filename', () => {
    const groups = groupsOf(run('tasks', q5!.code));
    const matching = allTasks.filter((f) => f.task.tags.some((t) => t.includes('#trabalho')));
    const byFile = new Map<string, string[]>();
    for (const f of matching) {
      const name = f.path.split('/').pop()!.replace(/\.md$/, '');
      byFile.set(name, [...(byFile.get(name) ?? []), key(f)]);
    }
    expect(groups).toEqual([...byFile.entries()].sort(([a], [b]) => a.localeCompare(b, 'pt-BR')));
    expect(groups.map(([label]) => label)).toEqual([
      '2026-10-02',
      'projeto-a',
      'projeto-b',
      'semana',
    ]);
  });

  it('6 not done + path includes tarefas + limit 5', () => {
    expect(taskKeys(run('tasks', q6!.code))).toEqual(
      allTasks
        .filter((f) => !DONE.test(f.task.status) && f.path.includes('tarefas'))
        .slice(0, 5)
        .map(key),
    );
  });

  it('7 is recurring', () => {
    const got = taskKeys(run('tasks', q7!.code));
    expect(got).toEqual(allTasks.filter((f) => f.task.recurrence !== undefined).map(key));
    expect(got.length).toBeGreaterThanOrEqual(8);
  });

  it('8 has due date + sort by priority + limit 10', () => {
    const expected = allTasks
      .filter((f) => f.task.due !== undefined)
      .sort((a, b) => b.task.priority - a.task.priority)
      .slice(0, 10);
    expect(taskKeys(run('tasks', q8!.code))).toEqual(expected.map(key));
  });

  it('9 description includes relatório', () => {
    expect(taskKeys(run('tasks', q9!.code))).toEqual(
      allTasks.filter((f) => f.task.text.toLowerCase().includes('relatório')).map(key),
    );
  });

  it('10 status.type is CANCELLED → recusada (fora de R-I9.4)', () => {
    expect(run('tasks', q10!.code)).toEqual({
      kind: 'error',
      line: 1,
      message: 'Instrução não reconhecida na linha 1: status.type is CANCELLED',
    });
  });
});

describe('AC-I9.5: 10 consultas dataview de referência', () => {
  const [d1, d2, d3, d4, d5, d6, d7, d8, d9, d10] = fxR7Queries().filter(
    (q) => q.info === 'dataview',
  );

  it('1 TASK FROM "tarefas" WHERE !completed', () => {
    expect(taskKeys(run('dataview', d1!.code))).toEqual(
      allTasks
        .filter(
          (f) => f.path.startsWith('tarefas/') && f.task.status !== 'x' && f.task.status !== 'X',
        )
        .map(key),
    );
  });

  // `grande-sertao-veredas.md` tem `title: Grande Sertão: Veredas` sem aspas: YAML inválido no
  // fixture, então a nota fica sem propriedades e sem tags do front matter (como no índice real).
  it('2 TABLE autor, ano, nota FROM "livros" SORT ano ASC (sem valor = "-" e por último)', () => {
    const result = run('dataview', d2!.code);
    expect(result).toMatchObject({ kind: 'table', columns: ['Nota', 'autor', 'ano', 'nota'] });
    expect(noteRows(result)).toEqual([
      ['livros/o-cortico.md', ['Aluísio Azevedo', '1890', '4']],
      ['livros/dom-casmurro.md', ['Machado de Assis', '1899', '5']],
      ['livros/vidas-secas.md', ['Graciliano Ramos', '1938', '5']],
      ['livros/a-hora-da-estrela.md', ['Clarice Lispector', '1977', '4']],
      ['livros/grande-sertao-veredas.md', ['-', '-', '-']],
    ]);
  });

  it('3 LIST FROM #romance', () => {
    expect(noteRows(run('dataview', d3!.code)).map(([path]) => path)).toEqual([
      'livros/dom-casmurro.md',
      'livros/o-cortico.md',
      'livros/vidas-secas.md',
    ]);
  });

  it('4 TABLE nota WHERE lido = true SORT nota DESC', () => {
    expect(noteRows(run('dataview', d4!.code))).toEqual([
      ['livros/dom-casmurro.md', ['5']],
      ['livros/a-hora-da-estrela.md', ['4']],
      ['livros/o-cortico.md', ['4']],
    ]);
  });

  it('5 LIST FROM [[Bolo]] = notas que apontam para receitas/Bolo.md (FX_R7_BOLO_SOURCES)', () => {
    expect(noteRows(run('dataview', d5!.code)).map(([path]) => path)).toEqual([
      'diario/2026-10-01.md',
      'links.md',
      'notas/relativo.md',
      'notas/sub/profunda.md',
      'wikilinks.md',
    ]);
  });

  it('6 TASK WHERE contains(text, "bolo")', () => {
    const got = taskKeys(run('dataview', d6!.code));
    expect(got).toEqual(allTasks.filter((f) => f.task.text.includes('bolo')).map(key));
    expect(got.length).toBeGreaterThan(10);
  });

  it('7 TABLE autor WHERE ano > 1900 LIMIT 2', () => {
    expect(noteRows(run('dataview', d7!.code))).toEqual([
      ['livros/a-hora-da-estrela.md', ['Clarice Lispector']],
      ['livros/vidas-secas.md', ['Graciliano Ramos']],
    ]);
  });

  it('8 LIST file.name FROM "diario"', () => {
    expect(noteRows(run('dataview', d8!.code))).toEqual([
      ['diario/2026-10-01.md', ['2026-10-01']],
      ['diario/2026-10-02.md', ['2026-10-02']],
    ]);
  });

  it('9 TASK FROM "tarefas/projeto-a.md" GROUP BY completed', () => {
    const inA = allTasks.filter((f) => f.path === 'tarefas/projeto-a.md');
    expect(groupsOf(run('dataview', d9!.code))).toEqual([
      ['false', inA.filter((f) => !/^[xX]$/.test(f.task.status)).map(key)],
      ['true', inA.filter((f) => /^[xX]$/.test(f.task.status)).map(key)],
    ]);
  });

  it('10 TABLE length(file.tasks) → recusada pelo nome', () => {
    expect(run('dataview', d10!.code)).toEqual({
      kind: 'error',
      line: 1,
      message: 'Não suportado nas consultas do simpleMD: length() (linha 1).',
    });
  });
});

// Casos sintéticos: cada ramo de filtro, ordenação, grupo e valor.
const T = (path: string, lines: string[], fm = '', mtime = 0) =>
  indexNote(path, `${fm}${lines.join('\n')}\n`, mtime);
const synth = [
  T('a/um.md', [
    '- [ ] alfa 📅 2026-10-09 🔺 #x',
    '- [x] beta ✅ 2026-10-10 ⏫ #x/y',
    '- [/] gama 🛫 2026-10-12 ⏳ 2026-10-11 🔁 every week',
    '- [-] delta ❌ 2026-10-01 🔽',
    '- [ ] épsilon 📅 2026-13-45 ➕ 2026-10-10',
  ]),
  T(
    'b/dois.md',
    ['- [ ] zeta ⏬ 📅 2026-10-11', '- [?] eta'],
    '---\nnota: 3\nprazo: 2026-10-05\nlista: [a, b]\ncapa: null\n---\n',
    Date.UTC(2026, 9, 9, 12),
  ),
  T('raiz.md', ['texto sem tarefas', '[[um]]'], '---\ntags: [projeto/sub]\n---\n'),
];
const synthCatalog = fakeCatalog(synth);
const synthRun = (kind: QueryKind, code: string, notePath = 'raiz.md') =>
  runQuery(kind, code, {
    notes: synthCatalog.getSnapshot().notes,
    catalog: synthCatalog,
    notePath,
    today: TODAY,
  });
const texts = (result: QueryResult) => {
  if (result.kind !== 'tasks') throw new Error(result.kind);
  return result.groups.flatMap((g) => g.rows.map((row) => row.ref.task.text.split(' ')[0]!));
};

describe('tasks: ramos do avaliador', () => {
  it.each([
    ['due before today', ['alfa']],
    ['due after today', ['zeta']],
    ['due on 2026-10-09', ['alfa']],
    ['scheduled on tomorrow', ['gama']],
    ['starts before today', ['alfa', 'beta', 'delta', 'épsilon', 'zeta', 'eta']],
    ['starts after today', ['alfa', 'beta', 'gama', 'delta', 'épsilon', 'zeta', 'eta']],
    ['done on today', ['beta']],
    ['created on today', ['épsilon']],
    ['has scheduled date', ['gama']],
    // `épsilon` tem 📅 inválido: o campo é ignorado (R-I9.2), então não tem data de vencimento.
    ['no due date', ['beta', 'gama', 'delta', 'épsilon', 'eta']],
    ['path does not include a/', ['zeta', 'eta']],
    ['tags do not include #x', ['gama', 'delta', 'épsilon', 'zeta', 'eta']],
    ['description does not include a', ['épsilon']],
    ['priority is above medium', ['alfa', 'beta']],
    ['priority is below none', ['delta', 'zeta']],
    ['priority is none', ['gama', 'épsilon', 'eta']],
    ['is not recurring', ['alfa', 'beta', 'delta', 'épsilon', 'zeta', 'eta']],
    ['not done', ['alfa', 'gama', 'épsilon', 'zeta', 'eta']],
    ['NOT (done)', ['alfa', 'gama', 'épsilon', 'zeta', 'eta']],
    ['(done) OR (is recurring)', ['beta', 'gama', 'delta']],
    ['(not done) AND (has due date)', ['alfa', 'zeta']],
  ])('%s', (code, expected) => expect(texts(synthRun('tasks', code))).toEqual(expected));

  it.each([
    ['sort by description', ['alfa', 'beta', 'delta', 'épsilon', 'eta', 'gama', 'zeta']],
    // `reverse` inverte a chave (sem data primeiro); empates seguem a ordem do índice.
    ['sort by due reverse', ['beta', 'gama', 'delta', 'épsilon', 'eta', 'zeta', 'alfa']],
    ['sort by scheduled', ['gama', 'alfa', 'beta', 'delta', 'épsilon', 'zeta', 'eta']],
    ['sort by done', ['beta', 'alfa', 'gama', 'delta', 'épsilon', 'zeta', 'eta']],
    ['sort by start', ['gama', 'alfa', 'beta', 'delta', 'épsilon', 'zeta', 'eta']],
    ['sort by path reverse', ['eta', 'zeta', 'épsilon', 'delta', 'gama', 'beta', 'alfa']],
    [
      'sort by priority\nsort by description reverse',
      ['alfa', 'beta', 'gama', 'eta', 'épsilon', 'delta', 'zeta'],
    ],
  ])('%s', (code, expected) => expect(texts(synthRun('tasks', code))).toEqual(expected));

  it.each([
    ['group by path', ['a/um.md', 'b/dois.md']],
    ['group by folder', ['a/', 'b/']],
    ['group by due', ['2026-10-09', '2026-10-11', 'Sem data de vencimento']],
    [
      'group by priority',
      [
        'Prioridade máxima',
        'Prioridade alta',
        'Sem prioridade',
        'Prioridade baixa',
        'Prioridade mínima',
      ],
    ],
    ['group by tags', ['#x', '#x/y', 'Sem tags']],
    [
      'group by folder\ngroup by priority',
      [
        'a/ › Prioridade máxima',
        'a/ › Prioridade alta',
        'a/ › Sem prioridade',
        'a/ › Prioridade baixa',
        'b/ › Sem prioridade',
        'b/ › Prioridade mínima',
      ],
    ],
  ])('%s', (code, labels) =>
    expect(groupsOf(synthRun('tasks', code)).map(([label]) => label)).toEqual(labels),
  );

  it('pasta raiz no group by folder vira "/"', () => {
    const single = fakeCatalog([T('solta.md', ['- [ ] x'])]);
    const result = runQuery('tasks', 'group by folder', {
      notes: single.getSnapshot().notes,
      catalog: single,
      notePath: '',
      today: TODAY,
    });
    expect(groupsOf(result).map(([l]) => l)).toEqual(['/']);
  });

  it('metadados STR-176 em texto, data inválida, hide/show, short mode, backlink', () => {
    const rows = (code: string) => {
      const r = synthRun('tasks', code);
      if (r.kind !== 'tasks') throw new Error();
      return r.groups[0]!.rows as TaskRow[];
    };
    const all = rows('');
    expect(all[0]).toMatchObject({
      meta: ['vence 2026-10-09', 'prioridade máxima'],
      origin: 'um › linha 1',
    });
    expect(all[1]!.meta).toEqual(['concluída 2026-10-10', 'prioridade alta']);
    expect(all[2]!.meta).toEqual([
      'agendada 2026-10-11',
      'início 2026-10-12',
      'repete: every week',
    ]);
    expect(all[3]!.meta).toEqual(['cancelada 2026-10-01', 'prioridade baixa']);
    expect(all[4]!.meta).toEqual(['criada 2026-10-10', 'data inválida']);
    expect(all[5]!.meta).toEqual(['vence 2026-10-11', 'prioridade mínima']);
    const hidden = rows(
      'hide due date\nhide priority\nhide backlink\nhide recurrence rule\nhide scheduled date\nhide start date\nhide done date',
    );
    expect(hidden.map((r) => r.meta)).toEqual([
      [],
      [],
      [],
      ['cancelada 2026-10-01'],
      ['criada 2026-10-10', 'data inválida'],
      [],
      [],
    ]);
    expect(hidden.every((r) => r.origin === null)).toBe(true);
    expect(rows('short mode').every((r) => r.meta.length === 0 && r.origin !== null)).toBe(true);
  });

  it('teto de 1.000 resultados sem limit; limit 0 = nenhum', () => {
    const many = T(
      'muitas.md',
      Array.from({ length: 1200 }, (_, i) => `- [ ] t${i}`),
    );
    const big = fakeCatalog([many]);
    const result = runQuery('tasks', 'not done', {
      notes: [many],
      catalog: big,
      notePath: '',
      today: TODAY,
    });
    expect(result).toMatchObject({ kind: 'tasks', count: 1000 });
    expect(
      runQuery('tasks', 'limit 0', { notes: [many], catalog: big, notePath: '', today: TODAY }),
    ).toMatchObject({ count: 0 });
  });
});

describe('dataview: ramos do avaliador', () => {
  const rows = (code: string, notePath = 'raiz.md') =>
    noteRows(synthRun('dataview', code, notePath));

  it.each([
    ['LIST WHERE nota = 3', ['b/dois.md']],
    ['LIST WHERE nota != 3', ['a/um.md', 'raiz.md']],
    ['LIST WHERE nota > 2 and nota < 4', ['b/dois.md']],
    ['LIST WHERE nota >= 3 or file.name = "um"', ['a/um.md', 'b/dois.md']],
    ['LIST WHERE nota <= "x"', []],
    ['LIST WHERE prazo < date(today)', ['b/dois.md']],
    ['LIST WHERE prazo = date(2026-10-05)', ['b/dois.md']],
    ['LIST WHERE date(2026-10-05) = prazo', ['b/dois.md']],
    ['LIST WHERE file.mtime >= date(2026-10-09) and file.mtime < date(2026-10-10)', ['b/dois.md']],
    ['LIST WHERE capa = null', ['a/um.md', 'b/dois.md', 'raiz.md']],
    ['LIST WHERE !capa', ['a/um.md', 'b/dois.md', 'raiz.md']],
    ['LIST WHERE lista', ['b/dois.md']],
    ['LIST WHERE contains(lista, "a")', ['b/dois.md']],
    ['LIST WHERE lista = lista', ['a/um.md', 'b/dois.md', 'raiz.md']],
    ['LIST WHERE contains(file.tags, "#projeto")', ['raiz.md']],
    ['LIST WHERE file.folder = "a"', ['a/um.md']],
    ['LIST WHERE file.path = "raiz.md"', ['raiz.md']],
    ['LIST WHERE file.size > 0', ['a/um.md', 'b/dois.md', 'raiz.md']],
    ['LIST WHERE NOTA = 3', ['b/dois.md']],
    ['LIST WHERE contains(file.name, 1)', []],
    ['LIST WHERE 0', []],
    ['LIST WHERE ""', []],
    ['LIST WHERE true = true', ['a/um.md', 'b/dois.md', 'raiz.md']],
    ['LIST FROM #projeto', ['raiz.md']],
    ['LIST FROM #projeto/sub', ['raiz.md']],
    ['LIST FROM #proj', []],
    ['LIST FROM "a/"', ['a/um.md']],
    ['LIST FROM ""', ['a/um.md', 'b/dois.md', 'raiz.md']],
    ['LIST FROM "a" or "b"', ['a/um.md', 'b/dois.md']],
    ['LIST FROM "a" and -"a"', []],
    ['LIST FROM [[um]]', ['raiz.md']],
    ['LIST FROM [[inexistente]]', []],
    ['LIST FROM not [[um]]', ['a/um.md', 'b/dois.md']],
  ])('%s', (code, expected) => expect(rows(code).map(([path]) => path)).toEqual(expected));

  it('TASK com campos da tarefa: status, priority, due, tags, start/scheduled/done', () => {
    const t = (code: string) => texts(synthRun('dataview', code));
    expect(t('TASK WHERE status = "/"')).toEqual(['gama']);
    expect(t('TASK WHERE priority = "highest"')).toEqual(['alfa']);
    expect(t('TASK WHERE priority > "medium"')).toEqual(['alfa', 'beta']);
    expect(t('TASK WHERE "high" = priority')).toEqual(['beta']);
    expect(t('TASK WHERE due < date(today)')).toEqual(['alfa']);
    expect(t('TASK WHERE contains(tags, "#x")')).toEqual(['alfa', 'beta']);
    expect(
      t(
        'TASK WHERE start = date(2026-10-12) or scheduled = date(2026-10-11) or done = date(today)',
      ),
    ).toEqual(['beta', 'gama']);
    expect(t('TASK WHERE completed SORT text DESC')).toEqual(['beta']);
    expect(t('TASK SORT priority DESC LIMIT 2')).toEqual(['alfa', 'beta']);
    expect(t('TASK WHERE nota = 3')).toEqual(['zeta', 'eta']);
  });

  it('SORT com nulos por último e tipos mistos; GROUP BY com rótulos e LIST/TABLE agrupados', () => {
    expect(rows('LIST SORT nota DESC').map(([p]) => p)).toEqual([
      'b/dois.md',
      'a/um.md',
      'raiz.md',
    ]);
    expect(rows('LIST SORT file.mtime DESC, file.name').map(([p]) => p)).toEqual([
      'b/dois.md',
      'raiz.md',
      'a/um.md',
    ]);
    const grouped = synthRun(
      'dataview',
      'TABLE nota, lista, prazo, file.mtime, capa GROUP BY file.folder',
    );
    expect(grouped).toMatchObject({
      kind: 'table',
      columns: ['Nota', 'nota', 'lista', 'prazo', 'file.mtime', 'capa'],
    });
    if (grouped.kind !== 'table') throw new Error();
    expect(grouped.groups.map((g) => g.label)).toEqual(['-', 'a', 'b']);
    expect(grouped.groups[2]!.rows[0]!.cells).toEqual([
      '3',
      'a, b',
      '2026-10-05',
      expect.stringMatching(/^2026-10-09 \d\d:\d\d$/),
      '-',
    ]);
    const list = synthRun('dataview', 'LIST nota GROUP BY nota');
    if (list.kind !== 'list') throw new Error();
    expect(list.groups.map((g) => [g.label, g.rows.map((r) => r.cells[0])])).toEqual([
      ['3', ['3']],
      ['-', ['-', '-']],
    ]);
  });

  it('displayValue: listas vazias, booleanos e prioridade', () => {
    expect(displayValue([])).toBe('-');
    expect(displayValue(true)).toBe('true');
    expect(displayValue({ priority: 4 })).toBe('high');
    expect(displayValue({ ms: new Date(2026, 0, 2).getTime(), day: true })).toBe('2026-01-02');
  });

  it('evaluateDataview aceita consulta já analisada', () => {
    const query = parseDataviewQuery('LIST FROM "b"') as DqlQuery;
    expect(evaluateDataview(query, source())).toMatchObject({ kind: 'list', count: 1 });
  });
});
