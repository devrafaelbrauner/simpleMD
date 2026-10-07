// @vitest-environment jsdom
import { completionStatus, startCompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PREFS_SAVE_DEBOUNCE_MS } from '../src/state/settings';
import { setup } from './helpers';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const CONFIG = '.simplemd/config.json';

describe('AC-8.6 persistência do autocompletar', () => {
  test('desligar grava enabled:false com ler-mesclar-gravar (x:1 fica); reabrir restaura', async () => {
    const h = await setup({ 'nota.md': '# Nota\n', [CONFIG]: '{"x":1,"autocomplete":{"y":2}}' });
    expect(h.app.store.getState().autocomplete.enabled).toBe(true);
    h.app.settings.setAutocomplete({ enabled: false });
    expect(h.app.store.getState().autocomplete.enabled).toBe(false);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    await h.settle();
    const saved = JSON.parse(h.port.readText(CONFIG) ?? '{}');
    expect(saved.x).toBe(1);
    expect(saved.autocomplete).toEqual({
      y: 2,
      enabled: false,
      mode: 'auto',
      minChars: 3,
      sources: { words: true, snippets: true, notes: true },
      snippetPrefix: '/',
    });
    // Reabrir a pasta (sessão nova das preferências) restaura "desligado".
    h.app.settings.setAutocomplete({ minChars: 9, snippetPrefix: 'x' as never });
    expect(h.app.store.getState().autocomplete).toMatchObject({ minChars: 5, snippetPrefix: '/' });
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    await h.app.sync.openVault('shell');
    expect(h.app.store.getState().autocomplete).toMatchObject({ enabled: false, minChars: 5 });
  });

  test('sem seção no config.json e sem mudança: nada de autocomplete é gravado; valor inválido avisa', async () => {
    const h = await setup({
      'nota.md': '# Nota\n',
      [CONFIG]: '{"autocomplete":{"enabled":"sim"}}',
    });
    const notices = h.app.store
      .getState()
      .notices.map((n) => `${n.text} ${n.detail ?? ''}`)
      .join('\n');
    expect(notices).toContain('autocomplete.enabled');
    expect(h.app.store.getState().autocomplete.enabled).toBe(true);
    const plain = await setup({ 'nota.md': '# Nota\n', [CONFIG]: '{"x":1}' });
    plain.app.settings.setTheme('simplemd-dark');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(JSON.parse(plain.port.readText(CONFIG) ?? '{}')).not.toHaveProperty('autocomplete');
  });
});

describe('AC-8.5 / AC-X.6 no editor do app', () => {
  test('5 alternâncias reconfiguram o mesmo EditorView; desligado = 0 popups (inclusive no atalho)', async () => {
    const h = await setup({ 'nota.md': 'paralelepípedo\n' });
    await h.app.sync.openFile('nota.md');
    const parent = document.createElement('div');
    const view = new EditorView({
      state: h.app.plugins.editor.refresh(h.app.registry.get('nota.md')!.state),
      parent,
    });
    h.app.plugins.editor.attach(view);
    view.dispatch({
      changes: { from: view.state.doc.length, insert: 'par' },
      selection: { anchor: view.state.doc.length + 3 },
    });
    for (let i = 0; i < 5; i++) {
      h.app.settings.setAutocomplete({ enabled: i % 2 === 1 });
      expect(h.app.plugins.editor.host.contributions.completion.enabled).toBe(i % 2 === 1);
    }
    // Termina desligado (i = 4): o atalho não abre nada.
    expect(startCompletion(view)).toBe(false);
    expect(completionStatus(view.state)).toBeNull();
    h.app.settings.setAutocomplete({ enabled: true, mode: 'manual' });
    expect(h.app.plugins.editor.host.contributions.completion.activateOnTyping).toBe(false);
    expect(startCompletion(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('paralelepípedo\npar');
    view.destroy();
  });
});
