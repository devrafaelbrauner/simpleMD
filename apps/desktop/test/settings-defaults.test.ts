import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { internalPluginDescriptors } from '../src/plugins/internal/index';
import { INTERNAL_PLUGIN_DEFAULTS, PREFS_SAVE_DEBOUNCE_MS } from '../src/state/settings';
import { setup } from './helpers';

/** r7 S0: padrões por plugin interno e `editor.captureTab` (product r7 §2.1, AC-X7.1). */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const CONFIG = '.simplemd/config.json';
const NOTA = '# Nota\n';
const ON = ['simplemd.mermaid', 'simplemd.katex', 'simplemd.calc', 'simplemd.tasks'];
const OFF = [
  'simplemd.vim',
  'simplemd.lint',
  'simplemd.latex-snippets',
  'simplemd.outliner',
  'simplemd.languagetool',
];

describe('AC-X7.1: padrões do r7 num vault novo', () => {
  test('sem config.json: Mermaid/KaTeX/calc/Tarefas ligados, Vim/lint/LaTeX/outliner/LT desligados, captureTab falso', async () => {
    const h = await setup({ 'nota.md': NOTA });
    for (const id of ON) expect([id, h.app.settings.internalPluginEnabled(id)]).toEqual([id, true]);
    for (const id of OFF)
      expect([id, h.app.settings.internalPluginEnabled(id)]).toEqual([id, false]);
    expect(h.app.settings.captureTab()).toBe(false);
    expect(h.app.store.getState().captureTab).toBe(false);
    expect(h.app.store.getState().notices).toEqual([]);
    expect(h.port.readText(CONFIG)).toBeNull();
  });

  test('a tabela cobre exatamente os 9 plugins internos do r7', () => {
    expect(Object.keys(INTERNAL_PLUGIN_DEFAULTS).sort()).toEqual([...ON, ...OFF].sort());
  });

  test('cada descritor de plugins/internal/<id>.ts declara o mesmo padrão da tabela', () => {
    const descriptors = internalPluginDescriptors();
    expect(descriptors.length).toBeGreaterThanOrEqual(3);
    for (const d of descriptors)
      expect([d.id, d.defaultEnabled]).toEqual([d.id, INTERNAL_PLUGIN_DEFAULTS[d.id]]);
  });

  test('escolha explícita vence o padrão; id sem padrão conhecido continua ligado; padrão explícito vale', async () => {
    const h = await setup({
      'nota.md': NOTA,
      [CONFIG]: JSON.stringify({
        plugins: { internal: { 'simplemd.vim': true, 'simplemd.mermaid': false } },
      }),
    });
    expect(h.app.settings.internalPluginEnabled('simplemd.vim')).toBe(true);
    expect(h.app.settings.internalPluginEnabled('simplemd.mermaid')).toBe(false);
    expect(h.app.settings.internalPluginEnabled('simplemd.outro')).toBe(true);
    expect(h.app.settings.internalPluginEnabled('simplemd.outro', false)).toBe(false);
    expect(h.app.settings.internalPluginEnabled('simplemd.vim', false)).toBe(true);
  });
});

describe('AC-X7.1: valor inválido → padrão + aviso do campo', () => {
  test('editor.captureTab e plugins.internal inválidos: padrão de cada um + um aviso config-field com os dois campos', async () => {
    const h = await setup({
      'nota.md': NOTA,
      [CONFIG]: JSON.stringify({
        editor: { captureTab: 'sim' },
        plugins: { internal: { 'simplemd.vim': 1, 'simplemd.tasks': 'não' } },
      }),
    });
    expect(h.app.settings.captureTab()).toBe(false);
    expect(h.app.settings.internalPluginEnabled('simplemd.vim')).toBe(false);
    expect(h.app.settings.internalPluginEnabled('simplemd.tasks')).toBe(true);
    const notices = h.app.store.getState().notices.filter((n) => n.notice === 'config-field');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.detail).toBe(
      'plugins.internal.simplemd.vim, plugins.internal.simplemd.tasks, editor.captureTab',
    );
  });

  test('valor inválido não é reescrito se o usuário não mexe na chave', async () => {
    const h = await setup({ 'nota.md': NOTA, [CONFIG]: '{"editor":{"captureTab":"sim"}}' });
    h.app.settings.setTheme('simplemd-dark');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(JSON.parse(h.port.readText(CONFIG) ?? '').editor.captureTab).toBe('sim');
  });
});

describe('AC-X7.1: editor.captureTab persiste com ler-mesclar-gravar', () => {
  test('ligar grava editor.captureTab e preserva todas as outras chaves; nova sessão restaura', async () => {
    const original = {
      x: 1,
      theme: 'simplemd-light',
      editor: { fontFamily: 'Fira Code', fontSize: 14, fontLigatures: true, futuro: 'fica' },
      plugins: { internal: { 'simplemd.calc': false }, outra: [1, 2] },
      futuro: { aninhado: { a: null } },
    };
    const h = await setup({ 'nota.md': NOTA, [CONFIG]: JSON.stringify(original) });
    h.app.settings.setCaptureTab(true);
    expect(h.app.store.getState().captureTab).toBe(true);
    expect(h.writes()).toBe(0);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(h.writes()).toBe(1);
    expect(JSON.parse(h.port.readText(CONFIG) ?? '')).toEqual({
      ...original,
      editor: { ...original.editor, captureTab: true },
    });

    // Repetir o valor não grava.
    h.app.settings.setCaptureTab(true);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(h.writes()).toBe(1);

    const again = await setup({});
    again.port.restore(h.port.snapshot());
    await again.app.sync.openVault('shell');
    expect(again.app.settings.captureTab()).toBe(true);
    again.app.settings.setCaptureTab(false);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(JSON.parse(again.port.readText(CONFIG) ?? '').editor.captureTab).toBe(false);
  });

  test('config.json sem a chave continua sem ela depois de outra mudança (só escolhas explícitas)', async () => {
    const h = await setup({ 'nota.md': NOTA, [CONFIG]: '{"x":1}' });
    h.app.settings.setFontSize(20);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    const saved = JSON.parse(h.port.readText(CONFIG) ?? '');
    expect(saved.x).toBe(1);
    expect('captureTab' in saved.editor).toBe(false);
    expect('plugins' in saved).toBe(false);
  });

  test('sem pasta: vale só na sessão (0 gravações) e volta se a primeira abertura falhar', async () => {
    const h = await setup({ 'nota.md': NOTA }, { open: false });
    h.app.settings.setCaptureTab(true);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.app.store.getState()).toMatchObject({ captureTab: true, persistence: 'session' });
    expect(h.writes()).toBe(0);
    h.port.fault({ op: 'readDir', error: 'IO' });
    await h.app.sync.openVault('welcome');
    expect(h.app.store.getState()).toMatchObject({ vaultStatus: 'closed', captureTab: true });
    expect(h.writes()).toBe(0);
  });
});
