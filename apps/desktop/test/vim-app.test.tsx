// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { completionStatus, startCompletion } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { CONFIG_PATH } from '@simplemd/themes';
import type * as Ui from '@simplemd/ui';
import { editorViewConstructions } from '@simplemd/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/app/App';
import vimDescriptor from '../src/plugins/internal/vim';
import { PREFS_SAVE_DEBOUNCE_MS } from '../src/state/settings';
import { setup, type Harness } from './helpers';

/**
 * r7 S4 — Modo Vim no app real (casca, `PluginHost`, `EditorAssembly`, atalhos de janela):
 * AC-I4.1 (VT: 0 `EditorView` novos, persistência), AC-I4.3 (VT: precedência nas 2 plataformas
 * simuladas), AC-I4.4 (parte VT: Esc + Tab e o alternador com o Vim; o foco real é PW/QA).
 */
const platform = vi.hoisted(() => ({ isMac: false }));
vi.mock('@simplemd/ui', async (orig) => ({
  ...(await orig<typeof Ui>()),
  get isMac() {
    return platform.isMac;
  },
}));

afterEach(() => {
  cleanup();
  platform.isMac = false;
});

const NOTE = 'paralelepípedo abc\n';

async function openNote(mac = false): Promise<{ h: Harness; view: EditorView }> {
  platform.isMac = mac;
  const h = await setup(
    { 'nota.md': NOTE, 'outra.md': 'Outra nota\n' },
    { internalDescriptors: [vimDescriptor] },
  );
  render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile('nota.md');
  });
  const view = h.app.plugins.editor.view;
  if (!view) throw new Error('editor não montado');
  return { h, view };
}

async function enableVim(h: Harness): Promise<void> {
  await act(async () => {
    await h.app.plugins.host.setEnabled('simplemd.vim', true);
  });
  await vi.waitFor(() => expect(screen.getByTestId('status-vim').textContent).toBe('NORMAL'));
}

/** `keydown` no editor, como o navegador entrega; devolve se alguém consumiu. */
function press(
  view: EditorView,
  key: string,
  mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
  const keyCode = key === 'Escape' ? 27 : key === 'Tab' ? 9 : key.toUpperCase().charCodeAt(0);
  Object.defineProperty(event, 'keyCode', { value: keyCode });
  act(() => {
    view.contentDOM.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

async function persisted(h: Harness): Promise<unknown> {
  let value: unknown;
  await vi.waitFor(
    () => {
      value = JSON.parse(h.port.readText(CONFIG_PATH) ?? '{}').plugins?.internal?.['simplemd.vim'];
      expect(value).toBeTypeOf('boolean');
    },
    { timeout: PREFS_SAVE_DEBOUNCE_MS * 5 },
  );
  return value;
}

describe('AC-I4.1 ligar/desligar sem recriar o editor; persistência', () => {
  test('interruptor do L2: 0 EditorView novos, o Vim age e some; plugins.internal.simplemd.vim gravado', async () => {
    const { h, view } = await openNote();
    const before = editorViewConstructions();
    act(() => h.app.store.setState({ settingsOpen: true, settingsSection: 'plugins' }));
    const toggle = screen.getByRole('switch', { name: 'Ativar “Modo Vim”' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(screen.getByTestId('status-vim').textContent).toBe('NORMAL'));
    await vi.waitFor(async () => expect(await persisted(h)).toBe(true));
    expect(view.scrollDOM.classList.contains('cm-vimMode')).toBe(true);
    act(() => h.app.store.setState({ settingsOpen: false }));
    expect(press(view, 'x')).toBe(true);
    expect(view.state.doc.toString()).toBe(NOTE.slice(1));

    act(() => h.app.store.setState({ settingsOpen: true, settingsSection: 'plugins' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Ativar “Modo Vim”' }));
    await vi.waitFor(() => expect(screen.queryByTestId('status-bar')).toBeNull());
    await vi.waitFor(async () => expect(await persisted(h)).toBe(false));
    expect(view.scrollDOM.classList.contains('cm-vimMode')).toBe(false);
    act(() => h.app.store.setState({ settingsOpen: false }));
    expect(press(view, 'x')).toBe(false);
    expect(view.state.doc.toString()).toBe(NOTE.slice(1));

    expect(editorViewConstructions() - before).toBe(0);
    expect(h.app.plugins.editor.view).toBe(view);
  });

  test('5 alternâncias seguidas: o mesmo EditorView; o estado final persiste ligado', async () => {
    const { h, view } = await openNote();
    const before = editorViewConstructions();
    for (let i = 0; i < 5; i++)
      await act(async () => {
        await h.app.plugins.host.setEnabled('simplemd.vim', i % 2 === 0);
      });
    await vi.waitFor(() => expect(screen.getByTestId('status-vim').textContent).toBe('NORMAL'));
    expect(await persisted(h)).toBe(true);
    expect(editorViewConstructions() - before).toBe(0);
    expect(h.app.plugins.editor.view).toBe(view);
  });
});

describe.each([
  ['other', false],
  ['mac', true],
] as const)('AC-I4.3 precedência com o Vim no modo normal — %s', (_name, mac) => {
  const mod = mac ? { metaKey: true } : { ctrlKey: true };

  test('Mod-Shift-P abre a paleta e Mod-W fecha a aba (globais vencem o Vim)', async () => {
    const { h, view } = await openNote(mac);
    await act(async () => {
      await h.app.sync.openFile('outra.md');
      await h.app.sync.openFile('nota.md');
    });
    await enableVim(h);
    expect(press(view, 'P', { ...mod, shiftKey: true })).toBe(true);
    expect(h.app.store.getState().paletteOpen).toBe(true);
    act(() => h.app.store.setState({ paletteOpen: false }));
    expect(screen.getByTestId('status-vim').textContent).toBe('NORMAL');
    const tabs = h.app.store.getState().tabs.length;
    expect(press(view, 'w', mod)).toBe(true);
    await vi.waitFor(() => expect(h.app.store.getState().tabs.length).toBe(tabs - 1));
    expect(h.app.store.getState().tabs.map((t) => t.id)).toEqual(['outra.md']);
    // O Vim não viu `w` nem `P`: a nota fechada ficou igual no disco.
    expect(h.port.readText('nota.md')).toBe(NOTE);
  });
});

test('AC-I4.3 Ctrl-B no modo normal (plataforma other) é do Vim, sem o negrito do markdown', async () => {
  const control = await openNote();
  control.view.dispatch({ selection: { anchor: 15, head: 18 } });
  expect(press(control.view, 'b', { ctrlKey: true })).toBe(true);
  expect(control.view.state.doc.toString()).toBe('paralelepípedo **abc**\n');
  cleanup();

  const { h, view } = await openNote();
  await enableVim(h);
  view.dispatch({ selection: { anchor: 15 } });
  expect(press(view, 'b', { ctrlKey: true })).toBe(true);
  expect(view.state.doc.toString()).toBe(NOTE);
  expect(screen.getByTestId('status-vim').textContent).toBe('NORMAL');
});

describe('AC-I4.4 (parte VT) saídas do editor com o Vim e a chave Tab ligados', () => {
  test('Esc no modo inserção vai ao normal E arma a saída: o Tab seguinte não é consumido', async () => {
    const { h, view } = await openNote();
    act(() => h.app.settings.setCaptureTab(true));
    await enableVim(h);
    press(view, 'i');
    expect(screen.getByTestId('status-vim').textContent).toBe('INSERÇÃO');
    expect(press(view, 'Escape')).toBe(true);
    expect(screen.getByTestId('status-vim').textContent).toBe('NORMAL');
    expect(press(view, 'Tab')).toBe(false);
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  test('o alternador (Ctrl-M) vence o Vim no modo inserção, anuncia e libera o Tab', async () => {
    const { h, view } = await openNote();
    act(() => h.app.settings.setCaptureTab(true));
    await enableVim(h);
    press(view, 'i');
    expect(press(view, 'm', { ctrlKey: true })).toBe(true);
    expect(screen.getByTestId('status-tab').getAttribute('data-mode')).toBe('focus');
    expect(screen.getByTestId('status-vim').textContent).toBe('INSERÇÃO');
    expect(view.dom.querySelector('.cm-announced')?.textContent).toBe('Tab move o foco');
    expect(press(view, 'Tab')).toBe(false);
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  test('com o popup aberto, Esc fecha o popup e o Vim continua em inserção (árbitro do núcleo)', async () => {
    const { h, view } = await openNote();
    await enableVim(h);
    press(view, 'A');
    expect(screen.getByTestId('status-vim').textContent).toBe('INSERÇÃO');
    act(() => {
      view.dispatch(view.state.replaceSelection(' par'), { userEvent: 'input.type' });
      startCompletion(view);
    });
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'));
    expect(press(view, 'Escape')).toBe(true);
    expect(completionStatus(view.state)).toBeNull();
    expect(screen.getByTestId('status-vim').textContent).toBe('INSERÇÃO');
  });
});
