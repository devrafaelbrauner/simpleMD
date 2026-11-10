import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { internalPluginDescriptors } from '../src/plugins/internal/index';
import { INTERNAL_PLUGIN_DEFAULTS, PREFS_SAVE_DEBOUNCE_MS } from '../src/state/settings';
import { setup } from './helpers';

/**
 * r7 S0: padrões por plugin interno e `editor.captureTab` (product r7 §2.1, AC-X7.1); r27b:
 * `editor.defaultMode` com o mesmo tratamento (fonte por padrão, D-P26-02); r36b: `index.cloudOnly`
 * (indexar notas só na nuvem, desligado por padrão); r35c: o corretor offline ligado por padrão.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const CONFIG = '.simplemd/config.json';
const NOTA = '# Nota\n';
const ON = [
  'simplemd.mermaid',
  'simplemd.katex',
  'simplemd.calc',
  'simplemd.tasks',
  'simplemd.spell',
];
const OFF = [
  'simplemd.vim',
  'simplemd.lint',
  'simplemd.latex-snippets',
  'simplemd.outliner',
  'simplemd.languagetool',
];

describe('AC-X7.1: padrões do r7 num vault novo', () => {
  test('sem config.json: Mermaid/KaTeX/calc/Tarefas/Ortografia offline ligados, Vim/lint/LaTeX/outliner/LT desligados, captureTab falso', async () => {
    const h = await setup({ 'nota.md': NOTA });
    for (const id of ON) expect([id, h.app.settings.internalPluginEnabled(id)]).toEqual([id, true]);
    for (const id of OFF)
      expect([id, h.app.settings.internalPluginEnabled(id)]).toEqual([id, false]);
    expect(h.app.settings.captureTab()).toBe(false);
    expect(h.app.store.getState().captureTab).toBe(false);
    expect(h.app.store.getState().notices).toEqual([]);
    expect(h.port.readText(CONFIG)).toBeNull();
  });

  test('a tabela cobre exatamente os 10 plugins internos (os 9 do r7 e o corretor offline da r35c)', () => {
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

describe('r27b (AC-R27B-1/2): editor.defaultMode, fonte por padrão e no molde de editor.captureTab', () => {
  test('sem config.json: fonte, sem aviso e nada gravado', async () => {
    const h = await setup({ 'nota.md': NOTA });
    expect(h.app.settings.defaultMode()).toBe('source');
    expect(h.app.store.getState().editorDefaultMode).toBe('source');
    expect(h.app.defaultModeInvalid.getSnapshot()).toBe(false);
    expect(h.app.store.getState().notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.writes()).toBe(0);
    expect(h.port.readText(CONFIG)).toBeNull();
  });

  test('escolher "live" grava editor.defaultMode e preserva as outras chaves; nova sessão restaura', async () => {
    const original = {
      x: 1,
      theme: 'simplemd-light',
      editor: {
        fontFamily: 'Fira Code',
        fontSize: 14,
        fontLigatures: true,
        captureTab: true,
        futuro: 'fica',
      },
      plugins: { internal: { 'simplemd.calc': false } },
    };
    const h = await setup({ 'nota.md': NOTA, [CONFIG]: JSON.stringify(original) });
    h.app.settings.setDefaultMode('live');
    expect(h.app.store.getState().editorDefaultMode).toBe('live');
    expect(h.writes()).toBe(0);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(h.writes()).toBe(1);
    expect(JSON.parse(h.port.readText(CONFIG) ?? '')).toEqual({
      ...original,
      editor: { ...original.editor, defaultMode: 'live' },
    });

    // Repetir o valor não grava.
    h.app.settings.setDefaultMode('live');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(h.writes()).toBe(1);

    const again = await setup({});
    again.port.restore(h.port.snapshot());
    await again.app.sync.openVault('shell');
    expect(again.app.settings.defaultMode()).toBe('live');
    // Valor válido do arquivo fica em outra gravação; voltar a "Fonte" grava "source".
    again.app.settings.setFontSize(20);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(JSON.parse(again.port.readText(CONFIG) ?? '').editor.defaultMode).toBe('live');
    again.app.settings.setDefaultMode('source');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(JSON.parse(again.port.readText(CONFIG) ?? '').editor).toEqual({
      ...original.editor,
      fontSize: 20,
      defaultMode: 'source',
    });
  });

  test('config.json sem a chave continua sem ela depois de outra mudança (só escolhas explícitas)', async () => {
    const h = await setup({ 'nota.md': NOTA, [CONFIG]: '{"editor":{"captureTab":false}}' });
    h.app.settings.setTheme('simplemd-dark');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(h.writes()).toBe(1);
    expect('defaultMode' in JSON.parse(h.port.readText(CONFIG) ?? '').editor).toBe(false);
  });

  test('valor inválido: aviso config-field que nomeia o campo, vale fonte e o arquivo não é regravado', async () => {
    const raw = '{"editor":{"defaultMode":"x","captureTab":"sim"},"y":2}';
    const h = await setup({ 'nota.md': NOTA, [CONFIG]: raw });
    expect(h.app.settings.defaultMode()).toBe('source');
    const notices = h.app.store.getState().notices.filter((n) => n.notice === 'config-field');
    expect(notices.map((n) => n.detail)).toEqual(['editor.captureTab, editor.defaultMode']);
    // SED-INVALID por campo: uma bandeira para cada um.
    expect(h.app.defaultModeInvalid.getSnapshot()).toBe(true);
    expect(h.app.captureTabInvalid.getSnapshot()).toBe(true);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.writes()).toBe(0);
    expect(h.port.readText(CONFIG)).toBe(raw);

    // Outra mudança grava o resto e deixa o valor inválido como estava.
    h.app.settings.setTheme('simplemd-dark');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(JSON.parse(h.port.readText(CONFIG) ?? '').editor.defaultMode).toBe('x');

    // Escolher um modo apaga só a bandeira desse campo e grava o valor escolhido.
    h.app.settings.setDefaultMode('live');
    expect(h.app.defaultModeInvalid.getSnapshot()).toBe(false);
    expect(h.app.captureTabInvalid.getSnapshot()).toBe(true);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(JSON.parse(h.port.readText(CONFIG) ?? '').editor).toMatchObject({
      defaultMode: 'live',
      captureTab: 'sim',
    });
  });

  test('sem pasta: vale só na sessão (0 gravações) e volta se a primeira abertura falhar; a pasta lê o próprio valor', async () => {
    const h = await setup({ 'nota.md': NOTA }, { open: false });
    expect(h.app.settings.defaultMode()).toBe('source');
    h.app.settings.setDefaultMode('live');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.app.store.getState()).toMatchObject({
      editorDefaultMode: 'live',
      persistence: 'session',
    });
    expect(h.writes()).toBe(0);
    h.port.fault({ op: 'readDir', error: 'IO' });
    await h.app.sync.openVault('welcome');
    expect(h.app.store.getState()).toMatchObject({
      vaultStatus: 'closed',
      editorDefaultMode: 'live',
    });
    expect(h.writes()).toBe(0);

    const fresh = await setup({ 'nota.md': NOTA }, { open: false });
    fresh.app.settings.setDefaultMode('live');
    await fresh.app.sync.openVault('welcome');
    expect(fresh.app.store.getState()).toMatchObject({
      vaultStatus: 'open',
      editorDefaultMode: 'source',
    });
    expect(fresh.writes()).toBe(0);
  });
});

describe('r36b (AC-R36-2): index.cloudOnly, desligado por padrão e no molde de editor.captureTab', () => {
  test('sem config.json: desligado, sem aviso e nada gravado', async () => {
    const h = await setup({ 'nota.md': NOTA });
    expect(h.app.store.getState().indexCloudOnly).toBe(false);
    expect(h.app.store.getState().notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.writes()).toBe(0);
    expect(h.port.readText(CONFIG)).toBeNull();
  });

  test('ligar grava index.cloudOnly e preserva as outras chaves (também as de index); nova sessão restaura', async () => {
    const original = {
      x: 1,
      theme: 'simplemd-light',
      editor: { fontFamily: 'Fira Code', fontSize: 14, fontLigatures: true, captureTab: true },
      index: { futuro: 'fica' },
    };
    const h = await setup({ 'nota.md': NOTA, [CONFIG]: JSON.stringify(original) });
    h.app.settings.setIndexCloudOnly(true);
    expect(h.app.store.getState().indexCloudOnly).toBe(true);
    expect(h.writes()).toBe(0);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(h.writes()).toBe(1);
    expect(JSON.parse(h.port.readText(CONFIG) ?? '')).toEqual({
      ...original,
      index: { futuro: 'fica', cloudOnly: true },
    });

    // Repetir o valor não grava.
    h.app.settings.setIndexCloudOnly(true);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(h.writes()).toBe(1);

    const again = await setup({});
    again.port.restore(h.port.snapshot());
    await again.app.sync.openVault('shell');
    expect(again.app.store.getState().indexCloudOnly).toBe(true);
    again.app.settings.setIndexCloudOnly(false);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(JSON.parse(again.port.readText(CONFIG) ?? '').index).toEqual({
      futuro: 'fica',
      cloudOnly: false,
    });
  });

  test('config.json sem a chave continua sem ela depois de outra mudança (só escolhas explícitas)', async () => {
    const h = await setup({ 'nota.md': NOTA, [CONFIG]: '{"x":1}' });
    h.app.settings.setFontSize(20);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(h.writes()).toBe(1);
    expect('index' in JSON.parse(h.port.readText(CONFIG) ?? '')).toBe(false);
  });

  test('valor inválido: aviso config-field que nomeia o campo, vale desligado e o arquivo não é regravado', async () => {
    const raw = '{"index":{"cloudOnly":"sim"},"y":2}';
    const h = await setup({ 'nota.md': NOTA, [CONFIG]: raw });
    expect(h.app.store.getState().indexCloudOnly).toBe(false);
    const fields = (state: { notices: readonly { notice: string; detail?: string }[] }) =>
      state.notices.filter((n) => n.notice === 'config-field').map((n) => n.detail);
    expect(fields(h.app.store.getState())).toEqual(['index.cloudOnly']);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.writes()).toBe(0);
    expect(h.port.readText(CONFIG)).toBe(raw);
    // Outra mudança grava o resto e deixa o valor inválido como estava.
    h.app.settings.setTheme('simplemd-dark');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(JSON.parse(h.port.readText(CONFIG) ?? '').index).toEqual({ cloudOnly: 'sim' });

    // `index` que não é objeto: aviso do campo `index`, desligado.
    const bad = await setup({ 'nota.md': NOTA, [CONFIG]: '{"index":3}' });
    expect(fields(bad.app.store.getState())).toEqual(['index']);
    expect(bad.app.store.getState().indexCloudOnly).toBe(false);
  });

  test('sem pasta: só na sessão (0 gravações); a abertura que falha volta a desligado e a pasta lê o próprio valor', async () => {
    const h = await setup({ 'nota.md': NOTA }, { open: false });
    h.app.settings.setIndexCloudOnly(true);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.app.store.getState()).toMatchObject({ indexCloudOnly: true, persistence: 'session' });
    expect(h.writes()).toBe(0);
    h.port.fault({ op: 'readDir', error: 'IO' });
    await h.app.sync.openVault('welcome');
    expect(h.app.store.getState()).toMatchObject({ vaultStatus: 'closed', indexCloudOnly: false });
    h.app.settings.setIndexCloudOnly(true);
    h.port.clearFaults();
    await h.app.sync.openVault('welcome');
    expect(h.app.store.getState()).toMatchObject({ vaultStatus: 'open', indexCloudOnly: false });
    expect(h.writes()).toBe(0);
  });
});
