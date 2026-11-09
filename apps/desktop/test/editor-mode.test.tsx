// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { undo, undoDepth } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import {
  EDITOR_MODE_ATTRIBUTE,
  isLivePreview,
  LIVE_PREVIEW_TEXT,
  type EditorMode,
} from '@simplemd/core';
import { editorViewConstructions } from '@simplemd/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { App } from '../src/app/App';
import { matchGlobalKey, TOGGLE_LIVE_PREVIEW_KEY } from '../src/app/global-keys';
import { setup, type Harness } from './helpers';

/**
 * r27a (AC-R27A-1/3/4): alternar o live preview no app real — atalho global `Mod-E`, comando da
 * paleta e item "Fonte"/"Prévia" da barra de status. Só reconfigura o estado mostrado: o mesmo
 * `EditorView`, nada gravado, aba limpa, desfazer intacto; o modo é de cada aba e sobrevive à
 * recarga do disco. Os testes partem do modo atual (o padrão muda na r27b).
 */
afterEach(cleanup);

const A = '# A\n\n**negrito** e texto\n';
const B = '# B\n\n- [ ] tarefa\n';
const TEXT: Record<EditorMode, string> = { source: 'Fonte', live: 'Prévia' };

async function openApp(): Promise<Harness> {
  const h = await setup({ 'a.md': A, 'b.md': B });
  render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile('a.md');
  });
  return h;
}

function editorOf(h: Harness): EditorView {
  const view = h.app.plugins.editor.view;
  if (!view) throw new Error('editor não montado');
  return view;
}

const modeOf = (h: Harness) => h.app.plugins.editor.mode.getSnapshot();
const flip = (mode: EditorMode): EditorMode => (mode === 'live' ? 'source' : 'live');

function current(h: Harness): EditorMode {
  const mode = modeOf(h);
  if (!mode) throw new Error('nenhuma nota mostrada');
  return mode;
}

/** Ctrl+E (jsdom não é macOS) no conteúdo do editor: o atalho global roda na captura da janela. */
function pressModE(target: Element): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'e',
    code: 'KeyE',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const activate = (h: Harness, id: string) => act(() => h.app.store.getState().activate(id));

describe('AC-R27A-1: Mod-E e o comando alternam ao vivo', () => {
  test('Ctrl+E: 0 EditorView novos, aba limpa e nada gravado; anuncia; doc, seleção e desfazer intactos', async () => {
    const h = await openApp();
    const view = editorOf(h);
    const start = current(h);
    const constructions = editorViewConstructions();
    const writes = h.writes();

    const event = pressModE(view.contentDOM);
    expect(event.defaultPrevented).toBe(true);
    expect(modeOf(h)).toBe(flip(start));
    expect(view.dom.getAttribute(EDITOR_MODE_ATTRIBUTE)).toBe(flip(start));
    expect(view.dom.querySelector('.cm-announced')?.textContent).toBe(
      flip(start) === 'live' ? LIVE_PREVIEW_TEXT.announceLive : LIVE_PREVIEW_TEXT.announceSource,
    );
    expect(h.app.store.getState().docs['a.md']).toBe('clean');
    await h.app.sync.flush('a.md');
    expect(h.writes()).toBe(writes);

    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: 'fim' } });
      view.dispatch({ selection: { anchor: 2, head: 3 } });
    });
    const doc = view.state.doc.toString();
    const selection = view.state.selection;
    expect(undoDepth(view.state)).toBe(1);
    pressModE(view.contentDOM);
    expect(modeOf(h)).toBe(start);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(undoDepth(view.state)).toBe(1);
    act(() => {
      expect(undo(view)).toBe(true);
    });
    expect(view.state.doc.toString()).toBe(A);

    expect(editorViewConstructions() - constructions).toBe(0);
    expect(h.app.plugins.editor.view).toBe(view);
  });

  test('paleta: "Editor: alternar live preview" com Ctrl+E; sem nota fica desabilitado e a tecla segue', async () => {
    const h = await setup({ 'a.md': A });
    render(<App app={h.app} />);
    const command = h.app.plugins.commands.get('editor:toggle-live-preview');
    expect(command?.title).toBe(LIVE_PREVIEW_TEXT.command);
    expect(command?.hotkey).toBe(TOGGLE_LIVE_PREVIEW_KEY);
    expect(command?.isEnabled?.()).toEqual({ reason: 'Abra uma nota primeiro.' });
    expect(pressModE(document.body).defaultPrevented).toBe(false);

    await act(async () => {
      await h.app.sync.openFile('a.md');
    });
    expect(command?.isEnabled?.()).toBe(true);
    const start = current(h);
    act(() => {
      void command?.run();
    });
    expect(modeOf(h)).toBe(flip(start));
    // Atalho global (Classe A): ⌘E no macOS, Ctrl+E nos demais; ⌘⇧E é do LaTeX.
    const key = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(matchGlobalKey({ ...key, key: 'e', metaKey: true }, 'mac')).toBe('toggle-live-preview');
    expect(matchGlobalKey({ ...key, key: 'E', ctrlKey: true }, 'other')).toBe(
      'toggle-live-preview',
    );
    expect(matchGlobalKey({ ...key, key: 'E', metaKey: true, shiftKey: true }, 'mac')).toBeNull();
  });
});

describe('AC-R27A-4: item "Fonte"/"Prévia" da barra de status', () => {
  test('botão com nome "Modo do editor: …" e atalho; clique alterna; segue a aba ativa', async () => {
    const h = await openApp();
    const start = current(h);
    const button = () => screen.getByTestId('status-mode');
    expect(button().tagName).toBe('BUTTON');
    expect(button().textContent).toBe(TEXT[start]);
    expect(button().getAttribute('data-mode')).toBe(start);
    expect(button().getAttribute('aria-label')).toBe(`Modo do editor: ${TEXT[start]}`);
    expect(button().getAttribute('aria-keyshortcuts')).toBe('Control+E');
    expect(button().getAttribute('title')).toBe('Alternar live preview (Ctrl+E)');

    fireEvent.click(button());
    expect(modeOf(h)).toBe(flip(start));
    expect(button().getAttribute('aria-label')).toBe(`Modo do editor: ${TEXT[flip(start)]}`);
    expect(editorOf(h).dom.getAttribute(EDITOR_MODE_ATTRIBUTE)).toBe(flip(start));

    await act(async () => {
      await h.app.sync.openFile('b.md');
    });
    expect(button().getAttribute('data-mode')).toBe(start);
    activate(h, 'a.md');
    expect(button().getAttribute('data-mode')).toBe(flip(start));
  });
});

describe('AC-R27A-3: o modo é de cada aba e sobrevive à recarga do disco', () => {
  test('aba ativa e aba de fundo recarregadas mantêm o modo; 0 EditorView novos', async () => {
    const h = await openApp();
    const view = editorOf(h);
    const start = current(h);
    const constructions = editorViewConstructions();
    pressModE(view.contentDOM);
    await act(async () => {
      await h.app.sync.openFile('b.md');
    });
    expect(modeOf(h)).toBe(start);
    pressModE(view.contentDOM);
    activate(h, 'a.md');
    expect(modeOf(h)).toBe(flip(start));

    h.port.externalWrite('b.md', '# B mudou\n');
    await act(async () => {
      await h.app.sync.checkTab('b.md');
    });
    expect(h.text('b.md')).toBe('# B mudou\n');
    expect(isLivePreview(h.app.registry.get('b.md')!.state)).toBe(flip(start) === 'live');

    h.port.externalWrite('a.md', '# A mudou\n');
    await act(async () => {
      await h.app.sync.checkTab('a.md');
    });
    expect(view.state.doc.toString()).toBe('# A mudou\n');
    expect(modeOf(h)).toBe(flip(start));

    activate(h, 'b.md');
    expect(view.state.doc.toString()).toBe('# B mudou\n');
    expect(modeOf(h)).toBe(flip(start));
    expect(editorViewConstructions() - constructions).toBe(0);
  });
});
