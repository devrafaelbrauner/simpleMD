import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  contextAction,
  createMarkdownExtensions,
  escapeHandler,
  interactFacet,
  problemsCommandsFacet,
} from '@simplemd/core';
import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalHostContext, VimStatus } from '@simplemd/plugin-api/internal/host';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LT_TIMING } from '../src/languagetool/checker';
import { createLanguageToolPlugin } from '../src/languagetool/index';
import { createVimPlugin } from '../src/vim/index';
import { destroyViews } from './helpers';
import {
  FakeClock,
  FakeDictionary,
  FakeTransport,
  flush,
  mountLt,
  type Mounted,
} from './lt-harness';

/**
 * r39a (design-r39 §1 "Plugins"): com o editor dividido, um plugin ativado uma vez vive em dois
 * views (um por grupo). Vim e LanguageTool seguem o view com foco; com um view só, os testes de
 * sempre (`vim.test.ts`, `languagetool*.test.ts`) valem iguais.
 */

const views: EditorView[] = [];
let lt: Mounted[] = [];
// Só o `setTimeout` global: o CodeMirror avisa a troca de foco aos plugins 10 ms depois (o relógio
// do LanguageTool é o falso do harness).
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  for (const m of lt) m.dispose();
  lt = [];
  destroyViews();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function mountView(state: EditorState): EditorView {
  const view = new EditorView({
    state,
    parent: document.body.appendChild(document.createElement('div')),
  });
  views.push(view);
  return view;
}

/** Foco no view e a atualização `focusChanged` que o CodeMirror entrega aos plugins. */
function focus(view: EditorView): void {
  view.focus();
  expect(view.hasFocus).toBe(true);
  vi.advanceTimersByTime(10);
}

/** `keydown` como o navegador entrega, no conteúdo do view (o Vim lê do `keydown`). */
function press(view: EditorView, key: string): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  const keyCode = key === 'Escape' ? 27 : key.toUpperCase().charCodeAt(0);
  Object.defineProperty(event, 'keyCode', { value: keyCode });
  Object.defineProperty(event, 'which', { value: keyCode });
  view.contentDOM.dispatchEvent(event);
}

/**
 * O grupo com foco do app (r39c, `focusedView`): o montador o troca sem foco do DOM (⌘\ com o foco
 * no explorador, junção) e avisa.
 */
function groupFocus() {
  const listeners = new Set<() => void>();
  let focused: EditorView | null = null;
  return {
    focusedView: {
      get: () => focused,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    set(view: EditorView | null) {
      focused = view;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** API que só junta as extensões registradas (o Vim e o LT não usam mais nada aqui). */
function recordingApi(extensions: Extension[]): PluginAPI {
  return {
    registerEditorExtension: (ext: { source?: Extension }) => {
      if (ext.source) extensions.push(ext.source);
    },
    settings: { get: () => undefined, set: () => Promise.resolve() },
    ui: { notify: () => {} },
  } as unknown as PluginAPI;
}

/** Editor do host com o grupo com foco do app. */
const editorHost = (
  focusedView: NonNullable<InternalHostContext['editor']['focusedView']>,
): InternalHostContext['editor'] => ({
  contextAction: (slot, action) => contextAction(slot, action),
  interact: (run) => interactFacet.of({ order: 10, run }),
  escape: (owner, run) => escapeHandler(owner, run),
  problems: (cmds) => problemsCommandsFacet.of(cmds),
  announce: () => {},
  focusedView,
});

const LT_OPTIONS: Record<string, unknown> = {
  mode: 'auto',
  language: 'pt-BR',
  addTo: 'global',
  disabledRules: [],
};

describe('Vim: o indicador é do view com foco (r39a)', () => {
  test('ao nascer só fala quem tem foco; o modo do view sem foco não aparece; ganhar o foco fala', () => {
    const statuses: Array<VimStatus | null> = [];
    const extensions: Extension[] = [];
    const api = {
      registerEditorExtension: (ext: { source?: Extension }) => {
        if (ext.source) extensions.push(ext.source);
      },
    } as unknown as PluginAPI;
    const host: InternalHostContext = {
      pluginId: 'simplemd.vim',
      platform: 'other',
      editor: {
        contextAction: () => [],
        interact: () => [],
        escape: () => [],
        announce: () => {},
      },
      vimStatus: { set: (value) => statuses.push(value), clear: () => statuses.push(null) },
      options: { get: <T>() => undefined as T, subscribe: () => () => {} },
      links: { openExternal: () => {} },
    };
    createVimPlugin(host).default(api);
    const state = (doc: string) =>
      EditorState.create({ doc, extensions: [createMarkdownExtensions(), extensions] });
    const left = mountView(state('esquerda'));
    focus(left);
    press(left, 'i');
    expect(statuses).toEqual([{ mode: 'normal' }, { mode: 'insert' }]);
    // O grupo da direita nasce (normal) com o foco na esquerda: o indicador segue "inserção".
    const right = mountView(state('direita'));
    expect(statuses.at(-1)).toEqual({ mode: 'insert' });
    focus(right);
    expect(statuses.at(-1)).toEqual({ mode: 'normal' });
    // A esquerda, sem foco, muda de modo: o indicador não muda.
    press(left, 'Escape');
    press(left, 'v');
    expect(statuses.at(-1)).toEqual({ mode: 'normal' });
    focus(left);
    expect(statuses.at(-1)).toEqual({ mode: 'visual' });
    // A direita fecha (junção): a esquerda, que já falou por último, segue com o indicador.
    right.destroy();
    views.splice(views.indexOf(right), 1);
    press(left, 'Escape');
    expect(statuses.at(-1)).toEqual({ mode: 'normal' });
  });

  test('r39c: com o grupo com foco do app, só ele fala — também sem foco do DOM e na junção', () => {
    const statuses: Array<VimStatus | null> = [];
    const extensions: Extension[] = [];
    const groups = groupFocus();
    createVimPlugin({
      pluginId: 'simplemd.vim',
      platform: 'other',
      editor: editorHost(groups.focusedView),
      vimStatus: { set: (value) => statuses.push(value), clear: () => statuses.push(null) },
      options: { get: <T>() => undefined as T, subscribe: () => () => {} },
      links: { openExternal: () => {} },
    }).default(recordingApi(extensions));
    const state = (doc: string) =>
      EditorState.create({ doc, extensions: [createMarkdownExtensions(), extensions] });
    // O montador liga o view ao grupo depois de criá-lo: o indicador vem dele.
    const left = mountView(state('esquerda'));
    groups.set(left);
    expect(statuses).toEqual([{ mode: 'normal' }]);
    focus(left);
    press(left, 'i');
    expect(statuses.at(-1)).toEqual({ mode: 'insert' });
    // ⌘\: o foco do DOM vai ao explorador; a direita nasce e só fala quando o store a foca.
    left.contentDOM.blur();
    vi.advanceTimersByTime(10);
    const right = mountView(state('direita'));
    expect(statuses.at(-1)).toEqual({ mode: 'insert' });
    groups.set(right);
    expect(statuses.at(-1)).toEqual({ mode: 'normal' });
    // Nenhum view com o foco do DOM: a esquerda muda de modo e o indicador fica com a direita.
    const before = statuses.length;
    press(left, 'Escape');
    press(left, 'v');
    expect(statuses).toHaveLength(before);
    // Junção no grupo da esquerda: o store a foca antes de o view da direita sair; ela fala.
    groups.set(left);
    right.destroy();
    views.splice(views.indexOf(right), 1);
    expect(statuses.at(-1)).toEqual({ mode: 'visual' });
  });
});

describe('LanguageTool: verifica o view com foco (r39a)', () => {
  test('o 2º view não toma o checker ao nascer nem ao editar; com o foco, o pedido do 1º sai e o dele entra', async () => {
    const m = mountLt('Primeira nota do grupo da esquerda.\n');
    lt.push(m);
    m.transport.checkReply = 'hang';
    await m.clock.advance(0);
    await flush();
    const [first] = m.transport.checks();
    expect(m.transport.checks()).toHaveLength(1);
    const right = mountView(
      m.view.state.update({
        changes: { from: 0, to: m.view.state.doc.length, insert: 'Segunda nota, à direita.\n' },
      }).state,
    );
    right.dispatch({ changes: { from: 0, insert: 'Uma ' }, userEvent: 'input.type' });
    await m.clock.advance(LT_TIMING.debounceMs * 2);
    expect(m.transport.checks()).toHaveLength(1);
    focus(right);
    expect(m.transport.checks()).toHaveLength(2);
    expect(m.transport.calls).toContainEqual({ op: 'cancel', id: first?.id });
    const sent = JSON.stringify(m.transport.checks()[1]?.request?.annotation);
    expect(sent).toContain('Uma Segunda nota');
    expect(sent).not.toContain('Primeira');
    // A edição no view sem foco (o da esquerda) não agenda pedido.
    m.view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });
    await m.clock.advance(LT_TIMING.debounceMs * 2);
    expect(m.transport.checks()).toHaveLength(2);
  });

  test('r39c: segue o grupo com foco do app sem foco do DOM; na junção, o view que fica verifica', async () => {
    const transport = new FakeTransport();
    transport.checkReply = 'hang';
    const clock = new FakeClock();
    const extensions: Extension[] = [];
    const groups = groupFocus();
    const dispose = createLanguageToolPlugin(
      {
        pluginId: 'simplemd.languagetool',
        platform: 'mac',
        editor: editorHost(groups.focusedView),
        ltStatus: { set: () => {}, clear: () => {}, onAction: () => () => {} },
        palette: () => [],
        options: {
          get: <T>(key: string) => LT_OPTIONS[key] as T,
          subscribe: () => () => {},
        },
        links: { openExternal: () => {} },
        languageTool: transport,
        dictionary: new FakeDictionary(),
      },
      clock,
    )(recordingApi(extensions));
    try {
      const state = (doc: string) =>
        EditorState.create({ doc, extensions: [createMarkdownExtensions(), extensions] });
      const settle = async () => {
        await clock.advance(0);
        await flush();
      };
      const left = mountView(state('Nota da esquerda, que fica.\n'));
      groups.set(left);
      await settle();
      expect(transport.checks()).toHaveLength(1);
      // ⌘\ com o foco no explorador: a direita nasce sem o checker e o toma quando o store a foca.
      const right = mountView(state('Nota da direita, que sai.\n'));
      await settle();
      expect(transport.checks()).toHaveLength(1);
      groups.set(right);
      await settle();
      expect(transport.checks()).toHaveLength(2);
      expect(JSON.stringify(transport.checks()[1]?.request?.annotation)).toContain('direita');
      // Junção no grupo da esquerda: verifica já o que ela mostra, sem esperar um clique.
      groups.set(left);
      right.destroy();
      views.splice(views.indexOf(right), 1);
      await settle();
      expect(transport.checks()).toHaveLength(3);
      expect(JSON.stringify(transport.checks()[2]?.request?.annotation)).toContain('esquerda');
    } finally {
      dispose();
    }
  });
});
