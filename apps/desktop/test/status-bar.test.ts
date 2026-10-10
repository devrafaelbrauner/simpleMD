// @vitest-environment jsdom
import { CONFIG_PATH } from '@simplemd/themes';
import { describe, expect, test, vi } from 'vitest';
import { GLOBAL_KEYS, matchGlobalKey } from '../src/app/global-keys';
import { StatusBarStore } from '../src/app/status-bar';
import { setup } from './helpers';

/** r7 ST — barra de status (slots), tabela de atalhos globais e a chave Tab no controlador. */
describe('StatusBarStore (DA-R7-1)', () => {
  test('três slots tipados; só publica quando muda; menu M2 chega ao registro do LT', () => {
    const store = new StatusBarStore();
    const seen = vi.fn();
    store.subscribe(seen);
    store.set('vim', { mode: 'insert' });
    store.set('vim', store.getSnapshot().vim);
    store.set('lt', { state: 'issues', count: 2 });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual({
      tab: null,
      vim: { mode: 'insert' },
      lt: { state: 'issues', count: 2 },
    });
    const actions: string[] = [];
    const off = store.onLtAction((a) => actions.push(a));
    store.runLtAction('retry');
    off();
    store.runLtAction('check-now');
    expect(actions).toEqual(['retry']);
  });
});

describe('GLOBAL_KEYS (D-R7-F20): mesmas regras do r1/r2', () => {
  const ev = (key: string, mods: Partial<KeyboardEvent> = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });
  test('Mod por plataforma, Shift exato, Alt nunca; Ctrl-Tab em todo sistema', () => {
    expect(matchGlobalKey(ev('P', { metaKey: true, shiftKey: true }), 'mac')).toBe('palette');
    expect(matchGlobalKey(ev('p', { ctrlKey: true, shiftKey: true }), 'mac')).toBeNull();
    expect(matchGlobalKey(ev('p', { ctrlKey: true }), 'other')).toBe('export-pdf');
    expect(matchGlobalKey(ev('o', { ctrlKey: true, altKey: true }), 'other')).toBeNull();
    expect(matchGlobalKey(ev(',', { metaKey: true }), 'mac')).toBe('settings');
    expect(matchGlobalKey(ev('Tab', { ctrlKey: true }), 'mac')).toBe('next-tab');
    expect(matchGlobalKey(ev('Tab', { ctrlKey: true, shiftKey: true }), 'other')).toBe('prev-tab');
    expect(matchGlobalKey(ev('Tab', { ctrlKey: true, metaKey: true }), 'mac')).toBeNull();
    expect(GLOBAL_KEYS.map((g) => g.id)).toHaveLength(new Set(GLOBAL_KEYS.map((g) => g.id)).size);
  });
});

describe('chave Tab no controlador (R-X7.1)', () => {
  test('ligar reconfigura #hostKeys e mostra "Tab: indenta"; desligar remove o slot', async () => {
    const h = await setup({ 'a.md': 'x' });
    const { statusBar, editor } = h.app.plugins;
    expect(statusBar.getSnapshot().tab).toBeNull();
    h.app.settings.setCaptureTab(true);
    expect(editor.host.contributions.captureTab).toBe(true);
    expect(statusBar.getSnapshot().tab).toEqual({ mode: 'indent' });
    h.app.settings.setCaptureTab(false);
    expect(editor.host.contributions.captureTab).toBe(false);
    expect(statusBar.getSnapshot().tab).toBeNull();
  });

  test('SED-INVALID: captureTab inválido no config.json acende a bandeira; mudar a chave apaga', async () => {
    const h = await setup({
      'a.md': 'x',
      [CONFIG_PATH]: JSON.stringify({ editor: { captureTab: 'sim' } }),
    });
    await vi.waitFor(() => expect(h.app.captureTabInvalid.getSnapshot()).toBe(true));
    expect(h.app.store.getState().captureTab).toBe(false);
    h.app.settings.setCaptureTab(true);
    expect(h.app.captureTabInvalid.getSnapshot()).toBe(false);
  });
});
