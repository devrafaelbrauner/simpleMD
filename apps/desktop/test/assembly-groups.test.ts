// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { EditorView } from '@codemirror/view';
import {
  loadTaskCompletion,
  openLinkAtCursor,
  problemsCommandsFacet,
  tabFocusMode,
  toggleTabFocusAnnounced,
} from '@simplemd/core';
import {
  CodeMirrorEditor,
  editorViewConstructions,
  type CodeMirrorEditorHandle,
} from '@simplemd/ui';
import { cleanup, render } from '@testing-library/react';
import { createElement, createRef } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as TasksCatalogModule from '../src/catalog/tasks-catalog';
import type { AppTasksCatalog } from '../src/catalog/tasks-catalog';
import { EditorAssembly } from '../src/editor/assembly';
import tasksDescriptor from '../src/plugins/internal/tasks';
import type { EditorGroup } from '../src/state/store';
import { setup, type Harness } from './helpers';

/**
 * r39a (design-r39 §1, §6) — o montador com dois views, sem a UI da r39b: cada grupo aqui é o que o
 * `EditorGroup` vai montar (um `CodeMirrorEditor` anexado no grupo, o `onChange` da aba que ele
 * mostra e o `showTab` do App). AC-R39A-1: sem gravação cruzada, tarefa e link no grupo certo.
 * AC-R39A-2: trocar de aba e juntar grupos não criam view.
 */

// O catálogo de tarefas criado pelo registro real (`plugins/internal/tasks.ts`), com a ligação dele.
const seen = vi.hoisted(() => ({ catalogs: [] as unknown[] }));
vi.mock('../src/catalog/tasks-catalog', async (original) => {
  const real = await original<typeof TasksCatalogModule>();
  return {
    ...real,
    createTasksCatalog: (...args: Parameters<typeof real.createTasksCatalog>) => {
      const catalog = real.createTasksCatalog(...args);
      seen.catalogs.push(catalog);
      return catalog;
    },
  };
});

afterEach(() => {
  cleanup();
  seen.catalogs.length = 0;
  document.body.innerHTML = '';
});

interface GroupEditor {
  readonly handle: CodeMirrorEditorHandle;
  readonly view: EditorView;
  /** Aba cujo estado está no view (a origem de cada `onChange`). */
  shown: string | null;
  /** O `showTab` do App: guarda a aba que sai; a nova vem com o que a junção guardou dela. */
  show(id: string): void;
  /** O grupo fecha (junção): sai do montador no cleanup de layout, depois o view é destruído. */
  close(): void;
}

function mountGroup(h: Harness, group: EditorGroup): GroupEditor {
  const { registry, sync } = h.app;
  const assembly = h.app.plugins.editor;
  const ref = createRef<CodeMirrorEditorHandle>();
  const state = { shown: null as string | null };
  const mounted = render(
    createElement(CodeMirrorEditor, {
      ref,
      initialState: assembly.emptyState(),
      onChange: (update) => {
        if (state.shown !== null) sync.onEditorChange(state.shown, update.state);
      },
    }),
  );
  const handle = ref.current!;
  assembly.attach(handle.view, group);
  return Object.assign(state, {
    handle,
    view: handle.view,
    show(id: string) {
      const previous = state.shown;
      const left = previous === null ? undefined : registry.get(previous);
      if (previous !== null && left?.state.doc.eq(handle.view.state.doc))
        registry.updateState(previous, handle.view.state);
      const record = registry.get(id)!;
      const parked = assembly.takeParked(id, record.state);
      state.shown = id;
      handle.setState(assembly.refresh(parked?.state ?? record.state));
      if (parked) handle.dispatch({ effects: parked.scroll });
    },
    close() {
      assembly.attach(null, group);
      mounted.unmount();
    },
  });
}

const decode = (bytes: Uint8Array | null) => new TextDecoder().decode(bytes ?? undefined);
const writesTo = (h: Harness, path: string) =>
  h.port.calls().filter((c) => c.op === 'writeFile' && c.abs.endsWith(`/${path}`));

/** Esquerda com `left` (grupo 0), direita (grupo 1, com o foco) com `right`, cada uma mostrando a última. */
async function split(h: Harness, left: string[], right: string[]) {
  for (const path of left) await h.app.sync.openFile(path);
  const groupLeft = mountGroup(h, 0);
  groupLeft.show(left.at(-1)!);
  expect(h.app.store.getState().splitEditor()).toBe(true);
  const groupRight = mountGroup(h, 1);
  for (const path of right) await h.app.sync.openFile(path);
  for (const path of right) groupRight.show(path);
  return { left: groupLeft, right: groupRight };
}

describe('AC-R39A-1 — com dois views, cada nota só grava no próprio arquivo', () => {
  test('o estado de A que passou pelo view da direita, editado na esquerda depois da junção, não grava em B', async () => {
    const A = '# A\n';
    const B = '# B\n';
    const h = await setup({ 'a.md': A, 'b.md': B, 'c.md': '# C\n' });
    const s = () => h.app.store.getState();
    // A e B no grupo da direita; a direita mostrou A e depois B (o estado de A passou por ela).
    const { left, right } = await split(h, ['c.md'], ['a.md', 'b.md']);
    expect(s().tabs.map((tab) => [tab.id, tab.group])).toEqual([
      ['c.md', 0],
      ['a.md', 1],
      ['b.md', 1],
    ]);
    s().mergeGroups(0);
    right.close();
    s().activate('a.md');
    left.show('a.md');
    h.port.resetCalls();
    left.handle.dispatch({ changes: { from: A.length, insert: 'digitado na esquerda\n' } });
    expect(s().docs).toMatchObject({ 'a.md': 'dirty', 'b.md': 'clean' });
    await h.app.sync.flushAll();
    expect(decode(h.port.readBytes('a.md'))).toBe(`${A}digitado na esquerda\n`);
    expect(decode(h.port.readBytes('b.md'))).toBe(B);
    expect(writesTo(h, 'b.md')).toEqual([]);
    expect(h.text('b.md')).toBe(B);
  });

  test('tarefa marcada numa nota aberta no grupo sem foco muda no view dela e não se perde na tecla seguinte', async () => {
    const T = '- [ ] tarefa\n';
    const h = await setup(
      { 'a.md': '# A\n', 't.md': T },
      { internalDescriptors: [tasksDescriptor] },
    );
    await vi.waitFor(() => expect(seen.catalogs).toHaveLength(1));
    const catalog = seen.catalogs[0] as AppTasksCatalog;
    const { right } = await split(h, ['a.md'], ['t.md']);
    h.app.store.getState().focusGroup(0);
    expect(h.app.plugins.editor.view).not.toBe(right.view);
    const { parseTaskLine } = await loadTaskCompletion();
    const task = parseTaskLine('- [ ] tarefa', 0)!;
    const result = await catalog.toggleTask({ path: 't.md', task }, { recordDoneDate: false });
    expect(result).toEqual({ ok: true, target: 'editor' });
    expect(right.view.state.doc.toString()).toBe('- [x] tarefa\n');
    // A tecla seguinte no view da direita leva a marca junto (antes: a edição ia só ao registro).
    right.handle.dispatch({ changes: { from: right.view.state.doc.length, insert: 'mais\n' } });
    await h.app.sync.flushAll();
    expect(decode(h.port.readBytes('t.md'))).toBe('- [x] tarefa\nmais\n');
  });

  test('link na esquerda para a nota aberta na direita: cursor no título e foco no view da direita', async () => {
    const h = await setup({
      'a.md': '[ver](b.md#Dois)\n',
      'b.md': '# Um\n\n## Dois\n\nfim\n',
    });
    const s = () => h.app.store.getState();
    const { left, right } = await split(h, ['a.md'], ['b.md']);
    s().focusGroup(0);
    left.handle.dispatch({ selection: { anchor: 2 } });
    expect(openLinkAtCursor(left.view)).toBe(true);
    const heading = '# Um\n\n'.length;
    await vi.waitFor(() => expect(right.view.state.selection.main.head).toBe(heading));
    expect(document.activeElement).toBe(right.view.contentDOM);
    expect(s()).toMatchObject({ focusedGroup: 1, activeId: 'b.md' });
    expect(s().tabs).toHaveLength(2);
    expect(h.app.plugins.editor.view).toBe(right.view);
    expect(left.view.state.selection.main.head).toBe(2);
  });
});

describe('AC-R39A-2 — trocar de aba e juntar grupos criam 0 views (regra 5)', () => {
  test('trocar de aba nos dois grupos e juntar: contador igual; o grupo que fecha guarda cursor e rolagem', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `linha ${i + 1}`).join('\n');
    const h = await setup({ 'a.md': '# A\n', 'b.md': long, 'c.md': '# C\n' });
    const s = () => h.app.store.getState();
    const { left, right } = await split(h, ['a.md'], ['b.md', 'c.md']);
    const built = editorViewConstructions();
    right.show('b.md');
    right.show('c.md');
    right.show('b.md');
    left.show('a.md');
    expect(editorViewConstructions()).toBe(built);

    const at = right.view.state.doc.line(300).from;
    right.handle.dispatch({ selection: { anchor: at } });
    Object.defineProperty(right.view.scrollDOM, 'scrollTop', { configurable: true, value: 4000 });
    const scrolled = right.view.scrollSnapshot().value;
    s().mergeGroups(0);
    right.close();
    expect(s()).toMatchObject({ split: false, focusedGroup: 0, activeId: 'a.md' });
    expect(s().tabs.map((tab) => [tab.id, tab.group])).toEqual([
      ['a.md', 0],
      ['b.md', 0],
      ['c.md', 0],
    ]);
    s().activate('b.md');
    const dispatch = vi.spyOn(left.view, 'dispatch');
    left.show('b.md');
    expect(editorViewConstructions()).toBe(built);
    expect(left.view.state.doc.toString()).toBe(long);
    expect(left.view.state.selection.main.head).toBe(at);
    const effects = dispatch.mock.calls.flatMap(([spec]) => [spec?.effects ?? []].flat());
    expect(effects.map((effect) => effect.value)).toContainEqual(scrolled);
    expect(h.app.plugins.editor.viewOf('b.md')).toBe(left.view);
    expect(h.app.plugins.editor.takeParked('b.md', left.view.state)).toBeNull();
  });

  test('takeParked: entregue uma vez e só com o mesmo documento; estado novo da nota descarta', () => {
    const assembly = new EditorAssembly(() => {});
    const view = new EditorView({
      state: assembly.createState('# B\n\nfim\n', 'b.md'),
      parent: document.body,
    });
    const park = () => {
      assembly.attach(view, 1);
      view.dispatch({ selection: { anchor: 3 } });
      assembly.attach(null, 1);
    };
    park();
    const stored = view.state;
    const changed = stored.update({ changes: { from: 0, insert: 'x' } }).state;
    expect(assembly.takeParked('b.md', changed)).toBeNull();
    expect(assembly.takeParked('b.md', stored)).toBeNull();
    park();
    expect(assembly.takeParked('b.md', stored)?.state).toBe(view.state);
    expect(assembly.takeParked('b.md', stored)).toBeNull();
    park();
    assembly.createState('# B\n\nfim\n', 'b.md');
    expect(assembly.takeParked('b.md', stored)).toBeNull();
    view.destroy();
  });

  test('AC-R39C-2: retainParked descarta a nota de aba fechada e não guarda mais a de aba fechada', () => {
    const assembly = new EditorAssembly(() => {});
    const view = new EditorView({
      state: assembly.createState('# B\n\nfim\n', 'b.md'),
      parent: document.body,
    });
    const park = () => {
      assembly.attach(view, 1);
      assembly.attach(null, 1);
    };
    const stored = view.state;
    const open = new Set(['b.md']);
    const tabOpen = (path: string) => open.has(path);
    // Aba aberta: guarda; a aba fecha sem voltar à tela (ou a pasta troca): sai na hora.
    assembly.retainParked(tabOpen);
    park();
    open.delete('b.md');
    assembly.retainParked(tabOpen);
    expect(assembly.takeParked('b.md', stored)).toBeNull();
    // O view sai depois de a aba fechar (a última aba do grupo): nada é guardado.
    park();
    expect(assembly.takeParked('b.md', stored)).toBeNull();
    // Aberta de novo: volta a guardar.
    open.add('b.md');
    assembly.retainParked(tabOpen);
    park();
    expect(assembly.takeParked('b.md', stored)?.state).toBe(view.state);
    view.destroy();
  });
});

describe('montador com dois grupos: contribuições nos dois, comandos e barra no foco', () => {
  test('apply/setAutocomplete/setCaptureTab chegam aos dois views; view, viewOf, modeOf e mode seguem o foco', async () => {
    const h = await setup({ 'a.md': '# A\n', 'b.md': '# B\n' });
    const assembly = h.app.plugins.editor;
    const s = () => h.app.store.getState();
    const { left, right } = await split(h, ['a.md'], ['b.md']);
    let applied = 0;
    assembly.onApplied(() => applied++);

    assembly.apply({
      pluginExtensions: [
        problemsCommandsFacet.of({ openPanel: () => true, next: () => true, prev: () => true }),
      ],
      completionSources: [],
      globalBindings: [],
    });
    h.app.settings.setAutocomplete({ ...s().autocomplete, enabled: !s().autocomplete.enabled });
    for (const view of [left.view, right.view]) {
      expect(view.state.facet(problemsCommandsFacet)).not.toBeNull();
      // Versão das contribuições em dia: o `refresh` não tem o que mudar.
      expect(assembly.refresh(view.state)).toBe(view.state);
    }
    toggleTabFocusAnnounced(right.view);
    toggleTabFocusAnnounced(left.view);
    h.app.settings.setCaptureTab(true);
    expect([tabFocusMode(left.view), tabFocusMode(right.view)]).toEqual(['indent', 'indent']);

    // Foco na direita (a aba nova entrou lá).
    expect(s().focusedGroup).toBe(1);
    expect(assembly.view).toBe(right.view);
    expect(assembly.viewOf('a.md')).toBe(left.view);
    expect(assembly.viewOf('b.md')).toBe(right.view);
    expect(assembly.viewOf('c.md')).toBeNull();
    expect(assembly.mode.getSnapshot()).toBe('source');
    expect(assembly.toggleLivePreview()).toBe(true);
    expect(assembly.mode.getSnapshot()).toBe('live');
    expect([assembly.modeOf('a.md'), assembly.modeOf('b.md')]).toEqual(['source', 'live']);

    // "Tab:" é do view com foco; o outro não fala.
    toggleTabFocusAnnounced(right.view);
    expect(h.app.plugins.statusBar.getSnapshot().tab).toEqual({ mode: 'focus' });
    toggleTabFocusAnnounced(left.view);
    expect(h.app.plugins.statusBar.getSnapshot().tab).toEqual({ mode: 'focus' });

    applied = 0;
    s().focusGroup(0);
    expect(applied).toBe(1);
    expect(assembly.view).toBe(left.view);
    expect(assembly.mode.getSnapshot()).toBe('source');
    expect(h.app.plugins.statusBar.getSnapshot().tab).toEqual({ mode: 'focus' });
    toggleTabFocusAnnounced(left.view);
    expect(h.app.plugins.statusBar.getSnapshot().tab).toEqual({ mode: 'indent' });
    expect(assembly.toggleLivePreview()).toBe(true);
    expect([assembly.modeOf('a.md'), assembly.modeOf('b.md')]).toEqual(['live', 'live']);
    s().focusGroup(1);
    expect(h.app.plugins.statusBar.getSnapshot().tab).toEqual({ mode: 'focus' });
  });
});
