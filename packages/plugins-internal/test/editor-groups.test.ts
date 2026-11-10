import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createMarkdownExtensions } from '@simplemd/core';
import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalHostContext, VimStatus } from '@simplemd/plugin-api/internal/host';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LT_TIMING } from '../src/languagetool/checker';
import { createVimPlugin } from '../src/vim/index';
import { destroyViews } from './helpers';
import { flush, mountLt, type Mounted } from './lt-harness';

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
});
