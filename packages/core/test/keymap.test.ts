// @vitest-environment jsdom
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarkdownState } from '../src';

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
});

function mount(doc: string, anchor: number, head = anchor): EditorView {
  const state = createMarkdownState(doc).update({ selection: { anchor, head } }).state;
  view = new EditorView({ state, parent: document.body });
  return view;
}

/** No jsdom `navigator.platform` não é Mac, então `Mod` = Ctrl. */
function press(target: EditorView, key: string, mods: { ctrlKey?: boolean } = { ctrlKey: true }) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
  return runScopeHandlers(target, event, 'editor');
}

describe('markdownKeymap (R-1.2)', () => {
  it('Mod-b alterna negrito na seleção', () => {
    const v = mount('abc', 0, 3);
    expect(press(v, 'b')).toBe(true);
    expect(v.state.doc.toString()).toBe('**abc**');
  });

  it('Mod-i alterna itálico (vence o selectParentSyntax do defaultKeymap)', () => {
    const v = mount('abc', 0, 3);
    expect(press(v, 'i')).toBe(true);
    expect(v.state.doc.toString()).toBe('*abc*');
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe('abc');
  });

  it('Mod-k insere link e seleciona "url"', () => {
    const v = mount('abc', 0, 3);
    expect(press(v, 'k')).toBe(true);
    expect(v.state.doc.toString()).toBe('[abc](url)');
    const { from, to } = v.state.selection.main;
    expect(v.state.sliceDoc(from, to)).toBe('url');
  });

  it('Tab não é capturado pelo editor (sem armadilha de teclado)', () => {
    const v = mount('abc', 3);
    expect(press(v, 'Tab', {})).toBe(false);
    expect(v.state.doc.toString()).toBe('abc');
  });

  it('o conteúdo tem o nome acessível "Editor de markdown"', () => {
    const v = mount('', 0);
    expect(v.contentDOM.getAttribute('aria-label')).toBe('Editor de markdown');
    expect(v.contentDOM.getAttribute('role')).toBe('textbox');
  });

  it('a11y F-1: o conteúdo é focável por Tab (tabindex 0) e Tab continua sem ser capturado', () => {
    const v = mount('abc', 3);
    expect(v.contentDOM.getAttribute('tabindex')).toBe('0');
    // O `.cm-scroller` do CodeMirror segue fora da ordem de Tab; o foco vai ao conteúdo.
    expect(v.scrollDOM.getAttribute('tabindex')).toBe('-1');
    expect(press(v, 'Tab', {})).toBe(false);
  });

  it('tabStop: false (prévia do editor de temas) tira o conteúdo da ordem de Tab', () => {
    const parent = document.createElement('div');
    const view = new EditorView({
      state: createMarkdownState('x', { readOnly: true, tabStop: false }),
      parent,
    });
    expect(view.contentDOM.getAttribute('tabindex')).toBe('-1');
    view.destroy();
  });
});
