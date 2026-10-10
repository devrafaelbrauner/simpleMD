import type { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msUntilLocalMidnight } from '../src/tasks/query/dates';
import { queryCounters } from '../src/tasks/render';
import {
  QUERY_LOADING_MS,
  QUERY_REFRESH_MS,
  QUERY_SLOW_MS,
  QueryController,
  queryBlocks,
  queryWidgetExtension,
} from '../src/tasks/widget';
import { destroyViews, mountView, pluginState, tick, viewDecorations } from './helpers';
import { fakeCatalog, indexNote } from './tasks-fixture';

const NOTE = indexNote(
  'tarefas/lista.md',
  '- [ ] comprar pão 📅 2026-10-12 ⏫\n- [x] pagar luz ✅ 2026-10-09\n- [ ] ler <b>&livro</b> #casa\n',
);
const OTHER = indexNote('outra.md', '# Outra\n\n[[lista]]\n');

function setup(
  doc: string,
  opts: { anchor?: number; focus?: boolean; status?: 'ready' | 'loading' | 'building' } = {},
) {
  const clock = { now: new Date(2026, 9, 10, 9) };
  const catalog = fakeCatalog([NOTE, OTHER], opts.status ?? 'ready');
  const toggleTask = vi.spyOn(catalog, 'toggleTask');
  const openSource = vi.spyOn(catalog, 'openSource');
  const openNote = vi.spyOn(catalog, 'openNote');
  const announce = vi.fn();
  const recordDoneDate = vi.fn(() => true);
  const controller = new QueryController({
    catalog,
    host: {
      platform: 'mac',
      options: { get: recordDoneDate as never, subscribe: () => () => {} },
      editor: { announce } as never,
    },
    notePathOf: () => 'consulta.md',
    now: () => clock.now,
  });
  const { extension, field } = queryWidgetExtension(controller);
  const view = mountView(doc, extension, { anchor: opts.anchor ?? 0, focus: opts.focus ?? false });
  return {
    catalog,
    controller,
    view,
    field,
    toggleTask,
    openSource,
    openNote,
    announce,
    recordDoneDate,
    clock,
  };
}

const widgets = (view: EditorView) => [
  ...view.contentDOM.querySelectorAll<HTMLElement>('[data-testid="query-widget"]'),
];
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
  );
const mouse = (el: Element, init: MouseEventInit = {}) =>
  el.dispatchEvent(
    new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true, ...init }),
  );

const TASKS_DOC = 'Antes\n\n```tasks\nnot done\n```\n\nDepois\n';
const BLOCK = TASKS_DOC.indexOf('```tasks');

beforeEach(() => {
  queryCounters.queryEvals = 0;
});
afterEach(() => {
  destroyViews();
  vi.useRealTimers();
});

describe('campo de blocos de consulta', () => {
  it('acha cercas de topo fechadas tasks/dataview/dataviewjs; aberta ou de outra linguagem fica crua', () => {
    const state = pluginState(
      '```tasks\ndone\n```\n\n```dataview\nLIST\n```\n\n```dataviewjs\ndv.x()\n```\n\n```js\nx\n```\n\n- item\n\n  ```tasks\n  done\n  ```\n\n```tasks\naberta',
      [],
    );
    expect(queryBlocks(state).map((b) => [b.fence, b.source])).toEqual([
      ['tasks', 'done'],
      ['dataview', 'LIST'],
      ['dataviewjs', 'dv.x()'],
    ]);
  });

  it('fora do cursor vira widget de bloco; cursor dentro (focado) → cru (QRY-REVEAL)', () => {
    const { view } = setup(TASKS_DOC);
    expect(viewDecorations(view).filter((d) => d.block)).toHaveLength(1);
    expect(widgets(view)).toHaveLength(1);
    const inside = setup(TASKS_DOC, { anchor: TASKS_DOC.indexOf('not done'), focus: true });
    expect(viewDecorations(inside.view).filter((d) => d.block)).toHaveLength(0);
    expect(widgets(inside.view)).toHaveLength(0);
  });

  it('NFR-41: 200 edições fora do bloco → 0 avaliações e o mesmo DOM do widget', () => {
    const { view } = setup(TASKS_DOC);
    const dom = widgets(view)[0];
    expect(queryCounters.queryEvals).toBe(1);
    for (let i = 0; i < 200; i++) view.dispatch({ changes: { from: 0, insert: 'a' } });
    for (let i = 0; i < 50; i++) {
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, insert: i % 2 ? 'x\n' : 'y' } });
    }
    expect(queryCounters.queryEvals).toBe(1);
    expect(widgets(view)[0]).toBe(dom);
  });

  it('editar o bloco (ou digitar crase) varre de novo; o mesmo texto reaproveita o DOM', () => {
    const { view, field } = setup(TASKS_DOC);
    const from = view.state.doc.toString().indexOf('not done');
    view.dispatch({ changes: { from, to: from + 4, insert: '' } });
    expect(view.state.field(field).blocks[0]!.source).toBe('done');
    expect(queryCounters.queryEvals).toBe(2);
    view.dispatch({ changes: { from: 0, insert: '```dataview\nLIST\n```\n\n' } });
    expect(view.state.field(field).blocks.map((b) => b.fence)).toEqual(['dataview', 'tasks']);
  });
});

describe('W3: estados e marcação (DESIGN §R7.6.14)', () => {
  it('resultados de tarefas: cabeçalho, linhas, caixa role=checkbox, metadados e origem; texto escapado', () => {
    const { view } = setup(TASKS_DOC);
    const [w] = widgets(view);
    expect(w).toMatchObject({ dataset: { kind: 'tasks', state: 'results' } });
    expect(w!.getAttribute('role')).toBe('group');
    expect(w!.getAttribute('aria-label')).toBe('Resultados da consulta tasks: 2 resultados');
    expect(w!.querySelector('.cm-query-count')!.textContent).toBe('2 resultados');
    expect(w!.querySelector('.cm-query-kind')!.textContent).toBe('tasks');
    const rows = w!.querySelectorAll('[data-testid="query-row"]');
    expect(rows).toHaveLength(2);
    const box = rows[0]!.querySelector('[role="checkbox"]')!;
    expect(box.getAttribute('aria-checked')).toBe('false');
    expect(box.getAttribute('aria-label')).toBe('Tarefa: comprar pão');
    expect(rows[0]!.querySelector('.cm-query-meta')!.textContent).toBe(
      'vence 2026-10-12 · prioridade alta · lista › linha 1',
    );
    expect(rows[0]!.querySelector('[data-testid="query-origin"]')!.getAttribute('role')).toBe(
      'link',
    );
    // Descrição como texto: nada de HTML da nota vira elemento.
    expect(rows[1]!.querySelector('.cm-query-desc')!.textContent).toBe('ler <b>&livro</b> #casa');
    expect(rows[1]!.querySelector('b')).toBeNull();
    expect(performance.getEntriesByName('simplemd:query-painted').length).toBeGreaterThan(0);
  });

  it('A-32: nenhum descendente tabbável em repouso (todos tabindex=-1) e nenhum <a>/[href]', () => {
    const { view } = setup(
      `${TASKS_DOC}\n\`\`\`dataview\nTABLE file.size\n\`\`\`\n\n\`\`\`dataview\nLIST\n\`\`\`\n`,
    );
    const all = widgets(view).flatMap((w) => [...w.querySelectorAll('[tabindex]')]);
    expect(all.length).toBeGreaterThan(4);
    expect(all.every((el) => el.getAttribute('tabindex') === '-1')).toBe(true);
    expect(view.contentDOM.querySelectorAll('a, [href]')).toHaveLength(0);
  });

  it('feita: aria-checked=true, ícone de check e texto atenuado; grupo com role=list + aria-labelledby', () => {
    const { view } = setup('```tasks\ngroup by filename\nsort by description\n```\n');
    const [w] = widgets(view);
    const label = w!.querySelector('.cm-query-group')!;
    const list = w!.querySelector('ul')!;
    expect(label.textContent).toBe('lista');
    expect(list.getAttribute('role')).toBe('list');
    expect(list.getAttribute('aria-labelledby')).toBe(label.id);
    const done = [...w!.querySelectorAll('[role="checkbox"]')].find(
      (b) => b.getAttribute('aria-checked') === 'true',
    )!;
    expect(done.querySelector('svg')).not.toBeNull();
    expect(done.closest('li')!.querySelector('.cm-md-task-done')).not.toBeNull();
  });

  it('LIST com valor e TABLE real (th scope=col, 1ª coluna = link da nota)', () => {
    const { view } = setup(
      '```dataview\nLIST file.folder\n```\n\n```dataview\nTABLE file.name AS "Nome"\nWHERE file.name = "outra"\n```\n',
    );
    const [list, table] = widgets(view);
    expect(list!.dataset.kind).toBe('dataview');
    const rows = list!.querySelectorAll('[data-testid="query-row"]');
    expect([...rows].map((r) => r.textContent)).toEqual(['Outra -', 'lista tarefas']);
    expect(rows[0]!.querySelector('[role="link"]')!.textContent).toBe('Outra');
    const ths = [...table!.querySelectorAll('th')];
    expect(ths.map((th) => [th.scope, th.textContent])).toEqual([
      ['col', 'Nota'],
      ['col', 'Nome'],
    ]);
    expect(table!.querySelector('tbody td [role="link"]')!.textContent).toBe('Outra');
  });

  it.each([
    ['```tasks\ndue befor today\n```\n', 'Instrução não reconhecida na linha 1: due befor today'],
    [
      '```dataview\nLIST\nFLATTEN x\n```\n',
      'Não suportado nas consultas do simpleMD: FLATTEN (linha 2).',
    ],
    ['```dataviewjs\nwindow.__ran = true\n```\n', 'Consultas em JavaScript não são suportadas'],
  ])('erro como alerta em linha, sem cabeçalho nem controles: %j', (doc, message) => {
    const { view } = setup(doc);
    const [w] = widgets(view);
    expect(w!.dataset.state).toBe('error');
    expect(w!.querySelector('.cm-query-alert p')!.textContent).toBe(message);
    expect(w!.querySelector('.cm-query-head, [role="checkbox"], [role="link"]')).toBeNull();
    expect('__ran' in globalThis).toBe(false);
  });

  it('dataviewjs não conta avaliação (0 execução)', () => {
    setup('```dataviewjs\ndv.paragraph(1)\n```\n');
    expect(queryCounters.queryEvals).toBe(0);
  });

  it('vazio: "Nenhum resultado", sem lista', () => {
    const { view } = setup('```tasks\ndescription includes inexistente\n```\n');
    const [w] = widgets(view);
    expect(w!.dataset.state).toBe('empty');
    expect(w!.querySelector('.cm-query-msg')!.textContent).toBe('Nenhum resultado');
    expect(w!.getAttribute('aria-label')).toBe('Resultados da consulta tasks: 0 resultados');
    expect(w!.querySelector('ul, table')).toBeNull();
  });

  it('índice em construção: "Indexando…" (aria-busy); pronto → resultados', () => {
    vi.useFakeTimers();
    const { view, catalog } = setup(TASKS_DOC, { status: 'building' });
    const [w] = widgets(view);
    expect(w!.dataset.state).toBe('indexing');
    expect(w!.getAttribute('aria-busy')).toBe('true');
    expect(w!.textContent).toContain('Indexando…');
    expect(queryCounters.queryEvals).toBe(0);
    catalog.publish([NOTE, OTHER]);
    vi.advanceTimersByTime(QUERY_REFRESH_MS);
    expect(w!.dataset.state).toBe('results');
    expect(w!.hasAttribute('aria-busy')).toBe(false);
  });

  it('carregando: nada até 150 ms, "Consultando…" depois, STR-46 aos 15 s', () => {
    vi.useFakeTimers();
    const { view } = setup(TASKS_DOC, { status: 'loading' });
    const [w] = widgets(view);
    expect(w!.dataset.state).toBe('loading');
    expect(w!.querySelector('.cm-query-msg')!.textContent).toBe('');
    vi.advanceTimersByTime(QUERY_LOADING_MS);
    expect(w!.querySelector('.cm-query-msg')!.textContent).toBe('Consultando…');
    vi.advanceTimersByTime(QUERY_SLOW_MS);
    expect(w!.querySelector('.cm-query-slow')!.textContent).toBe(
      'Isto está demorando mais que o esperado.',
    );
  });
});

describe('atualização (R-I9.8, AC-I9.9)', () => {
  it('publicação do catálogo → reavalia o widget visível depois de 500 ms (uma vez por rajada)', () => {
    vi.useFakeTimers();
    const { view, catalog } = setup(TASKS_DOC);
    const [w] = widgets(view);
    vi.spyOn(view, 'visibleRanges', 'get').mockReturnValue([
      { from: 0, to: view.state.doc.length },
    ]);
    const extra = indexNote('nova.md', '- [ ] tarefa nova\n');
    catalog.publish([NOTE, OTHER, extra]);
    catalog.publish([NOTE, OTHER, extra]);
    vi.advanceTimersByTime(QUERY_REFRESH_MS - 1);
    expect(queryCounters.queryEvals).toBe(1);
    vi.advanceTimersByTime(1);
    expect(queryCounters.queryEvals).toBe(2);
    expect(w!.querySelector('.cm-query-count')!.textContent).toBe('3 resultados');
  });

  it('fora da área visível não avalia; ao entrar na área, avalia uma vez', () => {
    vi.useFakeTimers();
    const { view, catalog, controller } = setup(TASKS_DOC);
    const visible = vi.spyOn(view, 'visibleRanges', 'get').mockReturnValue([]);
    catalog.publish([NOTE]);
    vi.advanceTimersByTime(QUERY_REFRESH_MS);
    expect(queryCounters.queryEvals).toBe(1);
    visible.mockReturnValue([{ from: 0, to: view.state.doc.length }]);
    controller.viewportChanged();
    controller.viewportChanged();
    expect(queryCounters.queryEvals).toBe(2);
  });

  it('virada do dia (meia-noite/foco) reavalia com o novo today; mesmo dia não', () => {
    const { view, controller, clock } = setup(TASKS_DOC);
    vi.spyOn(view, 'visibleRanges', 'get').mockReturnValue([
      { from: 0, to: view.state.doc.length },
    ]);
    controller.refreshDay();
    expect(queryCounters.queryEvals).toBe(1);
    clock.now = new Date(2026, 9, 11, 0, 1);
    window.dispatchEvent(new Event('focus'));
    expect(queryCounters.queryEvals).toBe(2);
  });

  it('dispose cancela a assinatura e os temporizadores', () => {
    vi.useFakeTimers();
    const { catalog, controller } = setup(TASKS_DOC);
    controller.dispose();
    catalog.publish([NOTE]);
    vi.advanceTimersByTime(QUERY_REFRESH_MS * 2);
    expect(queryCounters.queryEvals).toBe(1);
  });
});

describe('teclado e mouse (UX-R7-D5/D19, AC-I9.8)', () => {
  it('Mod-Shift-Enter com o cursor no bloco: anúncio, foco na 1ª caixa, roving com tabindex=0 só na ativa', () => {
    const doc = TASKS_DOC;
    const { view, controller, announce } = setup(doc, {
      anchor: doc.indexOf('not done'),
      focus: true,
    });
    expect(widgets(view)).toHaveLength(0);
    expect(controller.interact(view, view.state.selection.main.head)).toBe(true);
    const [w] = widgets(view);
    const boxes = [...w!.querySelectorAll<HTMLElement>('[role="checkbox"]')];
    expect(announce).toHaveBeenCalledWith(
      'Resultados da consulta: 2. Setas percorrem, Espaço marca, Enter abre a nota, Esc volta ao editor.',
    );
    expect(document.activeElement).toBe(boxes[0]);
    expect(boxes[0]!.tabIndex).toBe(0);
    expect(boxes[0]!.closest('li')!.classList.contains('cm-query-active')).toBe(true);
    key(boxes[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(boxes[1]);
    expect([boxes[0]!.tabIndex, boxes[1]!.tabIndex]).toEqual([-1, 0]);
    key(boxes[1]!, 'Home');
    expect(document.activeElement).toBe(boxes[0]);
    key(boxes[0]!, 'End');
    key(boxes[1]!, 'PageUp');
    expect(document.activeElement).toBe(boxes[0]);
    key(boxes[0]!, 'PageDown');
    key(boxes[1]!, 'ArrowUp');
    expect(document.activeElement).toBe(boxes[0]);
  });

  it('linha vizinha também entra; longe do bloco não; LIST anuncia sem "Espaço marca"', () => {
    const doc = 'x\n\n\n```dataview\nLIST\n```\ny\n';
    const { view, controller, announce } = setup(doc);
    expect(controller.interact(view, 0)).toBe(false);
    expect(controller.interact(view, doc.indexOf('y'))).toBe(true);
    expect(announce).toHaveBeenCalledWith(
      'Resultados da consulta: 2. Setas percorrem, Enter abre a nota, Esc volta ao editor.',
    );
    expect(document.activeElement?.getAttribute('role')).toBe('link');
  });

  it('sem itens: entra só com o anúncio do estado', () => {
    const { view, controller, announce } = setup('```tasks\ndue befor today\n```\n');
    expect(controller.interact(view, 0)).toBe(true);
    expect(announce).toHaveBeenCalledWith('Instrução não reconhecida na linha 1: due befor today');
  });

  it('Espaço alterna pelo catálogo (recordDoneDate) e anuncia; clique repetido em voo = 1 chamada', async () => {
    const { view, controller, toggleTask, announce } = setup(TASKS_DOC);
    controller.interact(view, BLOCK);
    const box = document.activeElement as HTMLElement;
    key(box, ' ');
    key(box, ' ');
    expect(toggleTask).toHaveBeenCalledTimes(1);
    expect(toggleTask.mock.calls[0]![0]).toMatchObject({
      path: 'tarefas/lista.md',
      task: { text: 'comprar pão' },
    });
    expect(toggleTask.mock.calls[0]![1]).toEqual({ recordDoneDate: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(announce).toHaveBeenLastCalledWith('Tarefa concluída.');
  });

  it('Enter abre a origem (tarefa) ou a nota (LIST)', () => {
    const t = setup(TASKS_DOC);
    t.controller.interact(t.view, BLOCK);
    key(document.activeElement!, 'Enter');
    expect(t.openSource).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'tarefas/lista.md' }),
    );
    destroyViews();
    const l = setup('```dataview\nLIST\n```\n');
    l.controller.interact(l.view, 0);
    key(document.activeElement!, 'Enter');
    expect(l.openNote).toHaveBeenCalledWith('outra.md');
  });

  it('Esc/Shift-Tab → editor no início do bloco; Tab → linha depois do bloco', () => {
    const doc = TASKS_DOC;
    const start = doc.indexOf('```tasks');
    const after = doc.indexOf('```\n\nDepois') + 4;
    for (const [k, shift, anchor] of [
      ['Escape', false, start],
      ['Tab', true, start],
      ['Tab', false, after],
    ] as const) {
      const { view, controller } = setup(doc);
      controller.interact(view, start);
      key(document.activeElement!, k, { shiftKey: shift });
      expect(view.state.selection.main.head).toBe(anchor);
      destroyViews();
    }
  });

  it('clique na caixa alterna sem mover o cursor; ⌘-clique na origem abre; clique comum revela o cru', async () => {
    const { view, toggleTask, openSource } = setup(TASKS_DOC, { anchor: 0 });
    const [w] = widgets(view);
    mouse(w!.querySelector('[role="checkbox"]')!);
    expect(toggleTask).toHaveBeenCalledTimes(1);
    expect(view.state.selection.main.head).toBe(0);
    mouse(w!.querySelector('[data-testid="query-origin"]')!, { ctrlKey: true });
    expect(openSource).not.toHaveBeenCalled();
    mouse(w!.querySelector('[data-testid="query-origin"]')!, { metaKey: true });
    expect(openSource).toHaveBeenCalledTimes(1);
    mouse(w!.querySelector('.cm-query-desc')!);
    expect(view.state.selection.main.head).toBe(TASKS_DOC.indexOf('```tasks'));
    await tick(50);
    expect(widgets(view)).toHaveLength(0);
  });

  it('reavaliação com o foco dentro preserva o foco na mesma posição', () => {
    vi.useFakeTimers();
    const { view, controller, catalog } = setup(TASKS_DOC);
    vi.spyOn(view, 'visibleRanges', 'get').mockReturnValue([
      { from: 0, to: view.state.doc.length },
    ]);
    controller.interact(view, BLOCK);
    key(document.activeElement!, 'ArrowDown');
    catalog.publish([indexNote('tarefas/lista.md', '- [ ] só uma\n')]);
    vi.advanceTimersByTime(QUERY_REFRESH_MS);
    const [w] = widgets(view);
    expect(document.activeElement).toBe(w!.querySelector('[role="checkbox"]'));
  });
});

describe('meia-noite pelo temporizador (CR-S9b-N11)', () => {
  it('relógio falso: reavalia na virada do dia e se rearma para a meia-noite seguinte', () => {
    vi.useFakeTimers();
    const { view, clock } = setup(TASKS_DOC);
    vi.spyOn(view, 'visibleRanges', 'get').mockReturnValue([
      { from: 0, to: view.state.doc.length },
    ]);
    const wait = msUntilLocalMidnight(clock.now);
    expect(wait).toBe(15 * 3_600_000);
    vi.advanceTimersByTime(wait - 1);
    expect(queryCounters.queryEvals).toBe(1);
    clock.now = new Date(2026, 9, 11, 0, 0, 0);
    vi.advanceTimersByTime(1);
    expect(queryCounters.queryEvals).toBe(2);
    clock.now = new Date(2026, 9, 11, 23, 59, 59);
    vi.advanceTimersByTime(24 * 3_600_000 - 1);
    expect(queryCounters.queryEvals).toBe(2);
    clock.now = new Date(2026, 9, 12, 0, 0, 0);
    vi.advanceTimersByTime(1);
    expect(queryCounters.queryEvals).toBe(3);
  });
});

describe('consulta patológica no widget (CR-S9b-B01)', () => {
  it.each([
    ['tasks', `${'('.repeat(10_000)}done${')'.repeat(10_000)}`],
    ['tasks', `${'NOT '.repeat(50_000)}(done)`],
    ['dataview', `LIST WHERE ${'('.repeat(10_000)}x${')'.repeat(10_000)}`],
    ['dataview', `LIST FROM ${'- '.repeat(50_000)}#a`],
  ])('%s: o toDOM não lança e mostra data-state="error" com o erro nomeado', (fence, query) => {
    const { view } = setup(`Antes\n\n\`\`\`${fence}\n${query}\n\`\`\`\n`);
    const [w] = widgets(view);
    expect(w!.dataset.state).toBe('error');
    expect(w!.querySelector('.cm-query-alert p')!.textContent).toBe(
      `Instrução não reconhecida na linha 1: ${query}`,
    );
  });

  it('exceção do anfitrião durante a avaliação vira erro no widget, sem sair do toDOM', () => {
    vi.useFakeTimers();
    const { view, controller, catalog } = setup(TASKS_DOC);
    vi.spyOn(view, 'visibleRanges', 'get').mockReturnValue([
      { from: 0, to: view.state.doc.length },
    ]);
    vi.spyOn(controller.env, 'notePathOf').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded.');
    });
    catalog.publish([NOTE, OTHER]);
    vi.advanceTimersByTime(QUERY_REFRESH_MS);
    const [w] = widgets(view);
    expect(w!.dataset.state).toBe('error');
    expect(w!.querySelector('.cm-query-alert p')!.textContent).toBe(
      'Instrução não reconhecida na linha 1: not done',
    );
  });
});
