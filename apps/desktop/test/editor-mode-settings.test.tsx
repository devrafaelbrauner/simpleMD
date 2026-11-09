// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { forceParsing } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import { EDITOR_MODE_ATTRIBUTE, isLivePreview } from '@simplemd/core';
import { builtinHotkeys, normalizeHotkey } from '@simplemd/plugin-api/runtime';
import { CONFIG_PATH } from '@simplemd/themes';
import { editorViewConstructions, isMac } from '@simplemd/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { App } from '../src/app/App';
import { setup, type Harness } from './helpers';

/**
 * r27b (AC-R27B-1/2): sem escolha, a nota abre no modo fonte (D-P26-02). Configurações → Editor →
 * "Ao abrir uma nota" (D-R27-07) grava `editor.defaultMode` e vale para as notas abertas depois;
 * as abas abertas ficam como estão. Valor inválido no `config.json`: aviso na seção e fonte, sem
 * regravar o arquivo. `Mod-e` fica reservado do app (D-R27-02).
 */
afterEach(cleanup);

const A = '# A\n\n**negrito** e texto\n';
const B = '# B\n\n- [ ] tarefa\n';

async function openApp(files: Record<string, string> = {}): Promise<Harness> {
  const h = await setup({ 'a.md': A, 'b.md': B, ...files });
  render(<App app={h.app} />);
  await openNote(h, 'a.md');
  return h;
}

async function openNote(h: Harness, path: string): Promise<void> {
  await act(async () => {
    await h.app.sync.openFile(path);
  });
}

function editorOf(h: Harness): EditorView {
  const view = h.app.plugins.editor.view;
  if (!view) throw new Error('editor não montado');
  return view;
}

/** A nota mostrada: modo, atributo do `.cm-editor`, item da barra e se há decorações da prévia. */
function shown(h: Harness) {
  const view = editorOf(h);
  // Árvore completa antes de olhar as decorações (sem depender do parse de fundo).
  forceParsing(view, view.state.doc.length, 5000);
  return {
    mode: h.app.plugins.editor.mode.getSnapshot(),
    attribute: view.dom.getAttribute(EDITOR_MODE_ATTRIBUTE),
    status: screen.getByTestId('status-mode').textContent,
    rendered: view.contentDOM.querySelector('.cm-md-h1, .cm-md-strong, .cm-md-task') !== null,
  };
}

const SOURCE = { mode: 'source', attribute: 'source', status: 'Fonte', rendered: false };
const LIVE = { mode: 'live', attribute: 'live', status: 'Prévia', rendered: true };

function openEditorSettings(h: Harness): HTMLSelectElement {
  act(() => h.app.store.setState({ settingsOpen: true, settingsSection: 'editor' }));
  return screen.getByRole<HTMLSelectElement>('combobox', { name: 'Ao abrir uma nota' });
}

const closeSettings = (h: Harness) => act(() => h.app.store.setState({ settingsOpen: false }));

const flushSettings = (h: Harness) =>
  act(async () => {
    await h.app.settings.flush();
  });

describe('AC-R27B-1: sem editor.defaultMode a nota abre no modo fonte', () => {
  test('markdown cru e "Fonte" na barra, também na próxima nota; nada gravado', async () => {
    const h = await openApp();
    expect(shown(h)).toEqual(SOURCE);
    const lines = editorOf(h).contentDOM.querySelectorAll('.cm-line');
    expect([...lines].map((line) => line.textContent)).toEqual([
      '# A',
      '',
      '**negrito** e texto',
      '',
    ]);
    expect(isLivePreview(h.app.registry.get('a.md')!.state)).toBe(false);
    await openNote(h, 'b.md');
    expect(shown(h)).toEqual(SOURCE);
    expect(h.port.readText(CONFIG_PATH)).toBeNull();
    expect(h.writes()).toBe(0);
  });
});

describe('AC-R27B-2: "Ao abrir uma nota" escolhe o modo das próximas notas', () => {
  test('"Prévia ao vivo" grava editor.defaultMode: "live"; a próxima nota abre com prévia e a aba aberta fica na fonte', async () => {
    const h = await openApp();
    const view = editorOf(h);
    const constructions = editorViewConstructions();
    const select = openEditorSettings(h);
    expect(select.value).toBe('source');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Fonte (padrão)',
      'Prévia ao vivo',
    ]);
    expect(screen.queryByTestId('set-default-mode-invalid')).toBeNull();

    fireEvent.change(select, { target: { value: 'live' } });
    expect(select.value).toBe('live');
    expect(h.app.store.getState().editorDefaultMode).toBe('live');
    expect(shown(h)).toEqual(SOURCE);
    await flushSettings(h);
    expect(JSON.parse(h.port.readText(CONFIG_PATH) ?? '')).toMatchObject({
      editor: { defaultMode: 'live' },
    });

    closeSettings(h);
    await openNote(h, 'b.md');
    expect(shown(h)).toEqual(LIVE);
    act(() => h.app.store.getState().activate('a.md'));
    expect(shown(h)).toEqual(SOURCE);
    // Um `EditorView` só; as notas não foram gravadas nem sujas.
    expect(editorViewConstructions() - constructions).toBe(0);
    expect(h.app.plugins.editor.view).toBe(view);
    expect([h.port.readText('a.md'), h.port.readText('b.md')]).toEqual([A, B]);
    expect(h.app.store.getState().docs).toEqual({ 'a.md': 'clean', 'b.md': 'clean' });
  });

  test('editor.defaultMode: "live" no config.json (outra sessão): as notas abrem com prévia; voltar a "Fonte" grava "source"', async () => {
    const h = await openApp({ [CONFIG_PATH]: JSON.stringify({ editor: { defaultMode: 'live' } }) });
    expect(shown(h)).toEqual(LIVE);
    const select = openEditorSettings(h);
    expect(select.value).toBe('live');
    fireEvent.change(select, { target: { value: 'source' } });
    await flushSettings(h);
    expect(JSON.parse(h.port.readText(CONFIG_PATH) ?? '').editor.defaultMode).toBe('source');
    closeSettings(h);
    await openNote(h, 'b.md');
    expect(shown(h)).toEqual(SOURCE);
    act(() => h.app.store.getState().activate('a.md'));
    expect(shown(h)).toEqual(LIVE);
  });

  test('valor inválido: aviso na seção Editor, a nota abre na fonte e o config.json não é regravado', async () => {
    const raw = JSON.stringify({ editor: { defaultMode: 'x' }, outra: 1 });
    const h = await openApp({ [CONFIG_PATH]: raw });
    expect(shown(h)).toEqual(SOURCE);
    const notice = h.app.store.getState().notices.find((n) => n.notice === 'config-field');
    expect(notice?.detail).toBe('editor.defaultMode');
    const select = openEditorSettings(h);
    // r28 NB-1: nenhum modo aparece escolhido; a opção desabilitada diz que "Fonte" vale.
    expect(select.value).toBe('');
    expect(select.selectedOptions[0]?.textContent).toBe('Fonte (valor inválido no arquivo)');
    expect(screen.getByTestId('set-default-mode-invalid').textContent).toBe(
      'Valor inválido em editor.defaultMode; usando “Fonte”.',
    );
    expect(screen.queryByTestId('set-capture-tab-invalid')).toBeNull();
    await flushSettings(h);
    expect(h.writes()).toBe(0);
    expect(h.port.readText(CONFIG_PATH)).toBe(raw);

    // Escolher um modo apaga o aviso e grava o valor escolhido; o resto do arquivo fica.
    fireEvent.change(select, { target: { value: 'live' } });
    expect(screen.queryByTestId('set-default-mode-invalid')).toBeNull();
    await flushSettings(h);
    expect(JSON.parse(h.port.readText(CONFIG_PATH) ?? '')).toMatchObject({
      editor: { defaultMode: 'live' },
      outra: 1,
    });
  });

  test('r28 NB-1: com o valor inválido, escolher "Fonte (padrão)" grava "source" e apaga o aviso', async () => {
    const raw = JSON.stringify({ editor: { defaultMode: 'x' }, outra: 1 });
    const h = await openApp({ [CONFIG_PATH]: raw });
    const select = openEditorSettings(h);
    expect(screen.getByTestId('set-default-mode-invalid')).toBeTruthy();

    fireEvent.change(select, { target: { value: 'source' } });
    expect(screen.queryByTestId('set-default-mode-invalid')).toBeNull();
    expect(select.value).toBe('source');
    expect([...select.options].map((option) => option.value)).toEqual(['source', 'live']);
    expect(h.app.defaultModeInvalid.getSnapshot()).toBe(false);
    await flushSettings(h);
    expect(JSON.parse(h.port.readText(CONFIG_PATH) ?? '')).toMatchObject({
      editor: { defaultMode: 'source' },
      outra: 1,
    });
    // Escolher de novo o modo que já vale (agora gravado) não grava outra vez.
    const writes = h.writes();
    fireEvent.change(select, { target: { value: 'source' } });
    await flushSettings(h);
    expect(h.writes()).toBe(writes);
    closeSettings(h);
    await openNote(h, 'b.md');
    expect(shown(h)).toEqual(SOURCE);
  });
});

describe('D-R27-02: Mod-e reservado do app', () => {
  test('um plugin de terceiro com Mod-e recebe o conflito de atalho embutido', async () => {
    for (const platform of ['mac', 'other'] as const)
      expect(builtinHotkeys([], platform).has(normalizeHotkey('Mod-e', platform))).toBe(true);
    // O mesmo caminho do `registerCommand` de um plugin (aviso "já é usado pelo simpleMD").
    const h = await setup({});
    const key = normalizeHotkey('Mod-e', isMac ? 'mac' : 'other');
    expect(h.app.plugins.contributions.bindHotkey('com.terceiro.x', key, () => true)).toEqual({
      bound: false,
      conflict: 'builtin',
    });
  });
});
