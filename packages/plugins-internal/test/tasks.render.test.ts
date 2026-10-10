import { describe, expect, it } from 'vitest';
import {
  createQuerySnapshotRenderer,
  evaluateBlock,
  queryCounters,
  queryFailure,
  queryFenceOf,
  queryResultHtml,
  resultCountLabel,
} from '../src/tasks/render';
import { fakeCatalog, indexNote } from './tasks-fixture';

const catalog = fakeCatalog([
  indexNote(
    'casa/a.md',
    '- [ ] lavar <louça> & secar #casa 📅 2026-10-12\n- [x] varrer ✅ 2026-10-09\n- [-] pintar\n',
  ),
  indexNote('b.md', '---\nautor: "Ana <b>"\n---\n# Bê\n'),
]);
const at = new Date(2026, 9, 10, 9);
const render = createQuerySnapshotRenderer(catalog, () => at);
const html = (fence: 'tasks' | 'dataview' | 'dataviewjs', code: string) =>
  render(fence, code, 'b.md') ?? '';
const parse = (markup: string) => new DOMParser().parseFromString(markup, 'text/html').body;

describe('instantâneo da exportação (AC-EX.4)', () => {
  it('tarefas: cabeçalho, ☐/☑ em texto, descrição escapada, metadados e origem em texto', () => {
    const body = parse(html('tasks', 'sort by description'));
    const frame = body.querySelector('.smd-query')!;
    expect(frame.getAttribute('data-kind')).toBe('tasks');
    expect(frame.querySelector('.smd-query-head')!.textContent).toBe('3 resultados tasks');
    const items = [...frame.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual([
      '☐ lavar <louça> & secar #casavence 2026-10-12 · a › linha 1',
      '☐ pintara › linha 3',
      '☑ varrerconcluída 2026-10-09 · a › linha 2',
    ]);
    expect(frame.querySelectorAll('.smd-query-done')).toHaveLength(2);
    expect(body.querySelectorAll('input, [role], a, [href], [tabindex]')).toHaveLength(0);
    expect(html('tasks', 'hide backlink\nshort mode')).not.toContain('linha');
  });

  it('reconhece a cerca pela info (palavras extras, caixa); outra cerca → null', () => {
    expect(render('Tasks extra', 'done', 'b.md')).toContain('data-kind="tasks"');
    expect(render('dataview', 'LIST', 'b.md')).toContain('data-kind="dataview"');
    expect(render('mermaid', 'graph TD', 'b.md')).toBeNull();
    expect(render('', 'done', 'b.md')).toBeNull();
  });

  it('grupos, LIST com valor, TABLE real, vazio e erros', () => {
    expect(
      parse(html('tasks', 'group by folder')).querySelectorAll('.smd-query-group'),
    ).toHaveLength(1);
    const list = parse(html('dataview', 'LIST autor'));
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Bê Ana <b>',
      'a -',
    ]);
    const table = parse(html('dataview', 'TABLE autor AS "Quem"\nGROUP BY file.folder'));
    expect(
      [...table.querySelectorAll('table:first-of-type th')].map((th) => [
        th.getAttribute('scope'),
        th.textContent,
      ]),
    ).toEqual([
      ['col', 'Nota'],
      ['col', 'Quem'],
    ]);
    expect(table.querySelectorAll('table')).toHaveLength(2);
    expect(parse(html('tasks', 'description includes nada')).textContent).toBe(
      'Nenhum resultado tasks',
    );
    expect(
      parse(html('dataview', 'LIST\nFLATTEN x')).querySelector('.smd-query-error')!.textContent,
    ).toBe('⚠ Não suportado nas consultas do simpleMD: FLATTEN (linha 2).');
    expect(parse(html('dataviewjs', 'dv.x(<script>)')).textContent).toBe(
      '⚠ Consultas em JavaScript não são suportadas',
    );
    expect(queryResultHtml('tasks', { kind: 'error', message: '<b>', line: 1 })).toContain(
      '&lt;b&gt;',
    );
  });

  it('contador queryEvals: soma por avaliação; dataviewjs não avalia', () => {
    const before = queryCounters.queryEvals;
    evaluateBlock('tasks', 'done', catalog, '', at);
    evaluateBlock('dataviewjs', 'x', catalog, '', at);
    expect(queryCounters.queryEvals).toBe(before + 1);
  });

  it('tipo da cerca e rótulo do cabeçalho', () => {
    expect(['tasks', 'Dataview x', 'dataviewjs', 'js', ''].map(queryFenceOf)).toEqual([
      'tasks',
      'dataview',
      'dataviewjs',
      null,
      null,
    ]);
    expect([0, 1, 2].map(resultCountLabel)).toEqual([
      '0 resultados',
      '1 resultado',
      '2 resultados',
    ]);
  });
});

describe('consulta patológica nunca lança (CR-S9b-B01)', () => {
  it('a exportação mostra o instantâneo de erro para 10.000 parênteses e 50.000 !', () => {
    const tasks = `${'('.repeat(10_000)}done${')'.repeat(10_000)}`;
    const frame = parse(html('tasks', tasks)).querySelector('.smd-query-error')!;
    expect(frame.getAttribute('data-kind')).toBe('tasks');
    expect(frame.textContent).toBe(`⚠ Instrução não reconhecida na linha 1: ${tasks}`);
    const dql = `LIST WHERE ${'!'.repeat(50_000)}x`;
    expect(parse(html('dataview', dql)).querySelector('.smd-query-error')!.textContent).toBe(
      `⚠ Instrução não reconhecida na linha 1: ${dql}`,
    );
  });

  it('exceção inesperada na avaliação → erro nomeado na 1ª linha não vazia, sem lançar', () => {
    const broken = {
      ...catalog,
      getSnapshot: () => {
        throw new RangeError('Maximum call stack size exceeded.');
      },
    };
    expect(evaluateBlock('dataview', '\n  LIST  \nWHERE x', broken, '', at)).toEqual({
      kind: 'error',
      line: 2,
      message: 'Instrução não reconhecida na linha 2: LIST',
    });
    expect(queryFailure('')).toEqual({
      kind: 'error',
      line: 1,
      message: 'Instrução não reconhecida na linha 1: ',
    });
    expect(createQuerySnapshotRenderer(broken, () => at)('tasks', 'done', 'b.md')).toContain(
      'smd-query-error',
    );
  });
});
