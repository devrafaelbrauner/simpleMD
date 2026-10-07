import { createHash } from 'node:crypto';
import { DEFAULT_PREFERENCES, fontOption, lightTokens, simplemdDark } from '@simplemd/themes';
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
const NOTA = '# Nota\n';
const sha = (bytes: Uint8Array | null) =>
  bytes === null ? null : createHash('sha256').update(bytes).digest('hex');

describe('preferências do vault (R-4.6, AC-4.9…4.11)', () => {
  test('sem pasta: mudanças valem na hora e nada é gravado (sessão)', async () => {
    const h = await setup({ 'nota.md': NOTA }, { open: false });
    h.app.settings.setTheme('simplemd-dark');
    h.app.settings.setFontSize(20);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.app.store.getState()).toMatchObject({
      themeId: 'simplemd-dark',
      persistence: 'session',
    });
    expect(h.root.applied.at(-1)?.tokens['--color-bg']).toBe(simplemdDark.tokens['--color-bg']);
    expect(h.root.applied.at(-1)?.tokens['--dimension-font-size']).toBe(`${20}px`);
    expect(h.writes()).toBe(0);
  });

  test('ao abrir a pasta, o config.json é aplicado ANTES de a casca aparecer (A-20)', async () => {
    const config = JSON.stringify({
      theme: 'simplemd-dark',
      editor: { fontFamily: 'Cascadia Code', fontSize: 18, fontLigatures: false },
    });
    const h = await setup({ 'nota.md': NOTA, [CONFIG]: config }, { open: false });
    const seen: Array<{ status: string; applied: number }> = [];
    h.app.store.subscribe((state, prev) => {
      if (state.vaultStatus !== prev.vaultStatus)
        seen.push({ status: state.vaultStatus, applied: h.root.applied.length });
    });
    await h.app.sync.openVault('welcome');
    expect(seen).toEqual([{ status: 'open', applied: 1 }]);
    const applied = h.root.applied[0];
    expect(applied?.base).toBe('dark');
    expect(applied?.tokens['--fontFamily-mono']).toBe(fontOption('Cascadia Code').stack);
    expect(applied?.tokens['--dimension-font-size']).toBe(`${18}px`);
    expect(h.root.ligatures.at(-1)).toBe(false);
    expect(h.app.store.getState().persistence).toBe('saved');
    expect(h.writes()).toBe(0);
  });

  test('AC-4.9: mudanças gravam ler-mesclar-gravar (300 ms), {"x":1} fica; nova sessão restaura', async () => {
    const h = await setup({ 'nota.md': NOTA, [CONFIG]: '{"x":1}' });
    h.app.settings.setTheme('simplemd-dark');
    h.app.settings.setFontFamily('Fira Code');
    h.app.settings.setFontSize(33);
    h.app.settings.setLigatures(false);
    expect(h.writes()).toBe(0);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(h.writes()).toBe(1);
    expect(JSON.parse(h.port.readText(CONFIG) ?? '')).toEqual({
      x: 1,
      theme: 'simplemd-dark',
      editor: { fontFamily: 'Fira Code', fontSize: 32, fontLigatures: false },
    });
    expect(h.root.fonts).toEqual([`${DEFAULT_PREFERENCES.fontSize}px "Fira Code"`]);

    // Nova sessão sobre o mesmo disco.
    const again = await setup({});
    again.port.restore(h.port.snapshot());
    await again.app.sync.openVault('shell');
    expect(again.app.store.getState()).toMatchObject({
      themeId: 'simplemd-dark',
      prefs: { fontFamily: 'Fira Code', fontSize: 32, fontLigatures: false },
    });
  });

  test('AC-4.11 / F-9: config malformado → padrões, aviso persistente, sha256 igual mesmo após mudanças', async () => {
    const h = await setup({ 'nota.md': NOTA, [CONFIG]: '{ "theme": ' });
    const before = sha(h.port.readBytes(CONFIG));
    const state = h.app.store.getState();
    expect(state.persistence).toBe('malformed');
    expect(state.themeId).toBe(DEFAULT_PREFERENCES.theme);
    expect(state.notices).toEqual([
      expect.objectContaining({ notice: 'config-malformed', kind: 'info', persistent: true }),
    ]);
    expect(state.notices[0]?.text).toBe(
      'O arquivo .simplemd/config.json é inválido; usando as preferências padrão. O arquivo não foi alterado.',
    );
    h.app.settings.setTheme('simplemd-dark');
    h.app.settings.setFontSize(12);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    await h.requestClose();
    expect(h.app.store.getState().themeId).toBe('simplemd-dark');
    expect(sha(h.port.readBytes(CONFIG))).toBe(before);
    expect(h.writes()).toBe(0);
  });

  test('tema salvo que não existe → claro + aviso theme-missing; campo inválido → aviso', async () => {
    const h = await setup({
      'nota.md': NOTA,
      [CONFIG]: '{"theme":"sumiu","editor":{"fontSize":"grande"}}',
    });
    const notices = h.app.store.getState().notices.map((n) => n.notice);
    expect(notices).toEqual(['theme-missing', 'config-field']);
    expect(h.app.store.getState().notices[1]?.detail).toBe('editor.fontSize');
    expect(h.root.applied.at(-1)?.tokens['--color-bg']).toBe(lightTokens['--color-bg']);
  });

  test('plugins.internal (etapa 7): valor que não é true/false → padrão (ligado) + aviso do campo', async () => {
    const h = await setup({
      'nota.md': NOTA,
      [CONFIG]: '{"plugins":{"internal":{"simplemd.calc":"não","simplemd.katex":false}}}',
    });
    expect(h.app.settings.internalPluginEnabled('simplemd.calc')).toBe(true);
    expect(h.app.settings.internalPluginEnabled('simplemd.katex')).toBe(false);
    expect(h.app.settings.internalPluginEnabled('simplemd.mermaid')).toBe(true);
    const notice = h.app.store.getState().notices.find((n) => n.notice === 'config-field');
    expect(notice?.detail).toBe('plugins.internal.simplemd.calc');
    const bad = await setup({ 'nota.md': NOTA, [CONFIG]: '{"plugins":[]}' });
    expect(bad.app.store.getState().notices.find((n) => n.notice === 'config-field')?.detail).toBe(
      'plugins.internal',
    );
  });

  test('falha ao gravar o config: linha "failed" + alerta; a preferência continua aplicada', async () => {
    const h = await setup({ 'nota.md': NOTA, [CONFIG]: '{}' });
    h.port.fault({ op: 'writeFile', error: 'IO', path: CONFIG });
    h.app.settings.setLigatures(false);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    const state = h.app.store.getState();
    expect(state.persistence).toBe('failed');
    expect(state.prefs.fontLigatures).toBe(false);
    expect(state.notices.at(-1)).toMatchObject({ kind: 'error', notice: 'prefs-failed' });
    h.port.clearFaults();
    h.app.settings.setLigatures(true);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(h.app.store.getState().persistence).toBe('saved');
    expect(h.app.store.getState().notices.some((n) => n.notice === 'prefs-failed')).toBe(false);
  });

  test('fechar a janela grava a mudança pendente antes do debounce', async () => {
    const h = await setup({ 'nota.md': NOTA });
    h.app.settings.setTheme('simplemd-dark');
    await expect(h.requestClose()).resolves.toBe(true);
    expect(JSON.parse(h.port.readText(CONFIG) ?? '')).toMatchObject({ theme: 'simplemd-dark' });
  });

  test('tamanho é limitado a 10–32 (AC-4.6) e repetir o valor não grava', async () => {
    const h = await setup({ 'nota.md': NOTA });
    h.app.settings.setFontSize(9);
    expect(h.app.store.getState().prefs.fontSize).toBe(10);
    h.app.settings.setFontSize(10);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(h.writes()).toBe(1);
  });
});

describe('correções da QA (fase 4)', () => {
  test.each(['PERMISSION_DENIED', 'IO'] as const)(
    'UIF F-03: a primeira abertura falha (%s) → boas-vindas com o tema e as fontes da sessão de volta',
    async (error) => {
      const h = await setup({ 'nota.md': NOTA }, { open: false });
      h.app.settings.setTheme('simplemd-dark');
      h.app.settings.setFontSize(20);
      h.app.settings.setLigatures(false);
      h.port.fault({ op: 'readDir', error });
      await h.app.sync.openVault('welcome');
      const state = h.app.store.getState();
      expect(state.vaultStatus).toBe('closed');
      expect(state.welcomeError).not.toBeNull();
      expect(state).toMatchObject({
        themeId: 'simplemd-dark',
        prefs: { fontSize: 20, fontLigatures: false },
        persistence: 'session',
      });
      expect(h.root.applied.at(-1)?.tokens['--color-bg']).toBe(simplemdDark.tokens['--color-bg']);
      expect(h.root.applied.at(-1)?.tokens['--dimension-font-size']).toBe(`${20}px`);
      expect(h.root.ligatures.at(-1)).toBe(false);
      expect(h.writes()).toBe(0);
    },
  );
});
