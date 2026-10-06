import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  REQUIRED_TOKENS,
  darkOverrides,
  lightTokens,
  serializeTheme,
  simplemdDark,
  themeFilePath,
  type ThemeDraft,
} from '@simplemd/themes';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PickedFile } from '../src/platform/types';
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
const NEW_BG = '#102030';
const sha = (bytes: Uint8Array | null) =>
  bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const fixture = (name: string) =>
  readFileSync(new URL(`../harness/fixtures/themes/${name}`, import.meta.url));
const picked = (name: string, bytes: Uint8Array, size = bytes.length): PickedFile => ({
  name,
  size,
  read: vi.fn(async () => bytes),
});

/** Rascunho como o L3 entrega: os 11 tokens obrigatórios, partindo do claro. */
function draft(name: string): ThemeDraft {
  const tokens = Object.fromEntries(REQUIRED_TOKENS.map((t) => [t, lightTokens[t] ?? '']));
  return { name, base: 'light', tokens: { ...tokens, '--color-bg': NEW_BG } };
}

describe('salvar como novo tema (R-5.4, AC-5.4, AC-5.6) — critério 3', () => {
  test('"Meu Tema": grava meu-tema/theme.json, ativa na raiz e persiste config.json theme', async () => {
    const h = await setup({ 'nota.md': NOTA, [CONFIG]: '{"x":1}' });
    await expect(h.app.settings.saveNewTheme(draft('Meu Tema'))).resolves.toBe(true);
    expect(h.port.readText(themeFilePath('meu-tema'))).toBe(serializeTheme(draft('Meu Tema')));
    expect(h.app.store.getState().themeId).toBe('meu-tema');
    expect(h.root.applied.at(-1)?.tokens['--color-bg']).toBe(NEW_BG);
    expect(h.app.store.getState().notices.at(-1)).toMatchObject({
      notice: 'theme-saved',
      text: 'Tema “Meu Tema” salvo em .simplemd/themes/meu-tema/ e ativado.',
    });
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(JSON.parse(h.port.readText(CONFIG) ?? '')).toMatchObject({ x: 1, theme: 'meu-tema' });

    // De novo: meu-tema-2, sem tocar no primeiro.
    const before = sha(h.port.readBytes(themeFilePath('meu-tema')));
    await h.app.settings.saveNewTheme(draft('Meu Tema'));
    expect(h.app.store.getState().themeId).toBe('meu-tema-2');
    expect(sha(h.port.readBytes(themeFilePath('meu-tema')))).toBe(before);
    expect(h.app.settings.themes().map((t) => t.id)).toEqual([
      'simplemd-light',
      'simplemd-dark',
      'meu-tema',
      'meu-tema-2',
    ]);
  });

  test('nova sessão: o tema salvo é listado e continua ativo', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.settings.saveNewTheme(draft('Meu Tema'));
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    const again = await setup({}, { open: false });
    again.port.restore(h.port.snapshot());
    await again.app.sync.openVault('welcome');
    expect(again.app.store.getState().themeId).toBe('meu-tema');
    expect(again.root.applied[0]?.tokens['--color-bg']).toBe(NEW_BG);
  });

  test('falha ao gravar: false, nada é ativado (STR-38)', async () => {
    const h = await setup({ 'nota.md': NOTA });
    h.port.fault({ op: 'writeFile', error: 'IO' });
    await expect(h.app.settings.saveNewTheme(draft('Meu Tema'))).resolves.toBe(false);
    expect(h.app.store.getState().themeId).toBe('simplemd-light');
    expect(h.app.store.getState().userThemes).toEqual([]);
  });

  test('sem pasta: false e 0 escritas', async () => {
    const h = await setup({ 'nota.md': NOTA }, { open: false });
    await expect(h.app.settings.saveNewTheme(draft('Meu Tema'))).resolves.toBe(false);
    expect(h.writes()).toBe(0);
  });
});

describe('importar (R-5.6, AC-5.8, AC-5.9, AC-5.10)', () => {
  test('válido: copiado, listado, NÃO ativado; aviso STR-32', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.settings.importFile(picked('FX-THEME-OK.json', fixture('FX-THEME-OK.json')));
    const state = h.app.store.getState();
    expect(state.importError).toBeNull();
    expect(state.userThemes.map((t) => t.id)).toEqual(['meu-tema']);
    expect(state.themeId).toBe('simplemd-light');
    expect(state.notices.at(-1)).toMatchObject({
      notice: 'theme-imported',
      text: 'Tema “Meu Tema” importado.',
    });
    h.app.settings.setTheme('meu-tema');
    expect(h.root.applied.at(-1)?.tokens['--color-hover']).toBe(darkOverrides['--color-hover']);
  });

  test.each([
    ['FX-THEME-BAD-JSON.json', 'arquivo', 'JSON malformado'],
    [
      'FX-THEME-BAD-NAME.json',
      'tokens.--bg',
      'nome de token fora do padrão --<grupo>-<nome> (D-1)',
    ],
    [
      'FX-THEME-BAD-HEX.json',
      'tokens.--color-bg',
      'cor deve ser hexadecimal (#rgb, #rgba, #rrggbb ou #rrggbbaa)',
    ],
    [
      'FX-THEME-BAD-URL.json',
      'tokens.--fontFamily-ui',
      'o valor contém caracteres ou funções proibidos',
    ],
  ])('inválido %s: alerta nomeia "%s" e 0 escritas', async (file, field, reason) => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.settings.importFile(picked(file, fixture(file)));
    expect(h.app.store.getState().importError).toBe(
      `Tema inválido — campo “${field}”: ${reason}. Nada foi gravado.`,
    );
    expect(h.writes()).toBe(0);
  });

  test('257 KB: recusado ANTES de ler, 0 escritas', async () => {
    const h = await setup({ 'nota.md': NOTA });
    const file = picked('grande.json', new Uint8Array(0), 257 * 1024);
    await h.app.settings.importFile(file);
    expect(file.read).not.toHaveBeenCalled();
    expect(h.app.store.getState().importError).toBe(
      'Tema inválido — campo “arquivo”: maior que 256 KB. Nada foi gravado.',
    );
    expect(h.writes()).toBe(0);
  });

  test('diálogo nativo: cancelar não muda nada; escolher importa', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.settings.importFromDialog();
    expect(h.writes()).toBe(0);
    expect(h.app.store.getState().importError).toBeNull();
    h.platform.pickFile.mockResolvedValueOnce(picked('ok.json', fixture('FX-THEME-OK.json')));
    await h.app.settings.importFromDialog();
    expect(h.app.store.getState().userThemes.map((t) => t.id)).toEqual(['meu-tema']);
  });

  test('css preservado na importação e na exportação (AC-5.10)', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.settings.importFile(picked('css.json', fixture('FX-THEME-CSS.json')));
    h.app.settings.setTheme('com-css');
    await h.app.settings.exportTheme();
    const bytes = h.platform.saveFile.mock.calls[0]?.[1];
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ css: 'x.css' });
    expect(sha(bytes ?? null)).toBe(sha(h.port.readBytes(themeFilePath('com-css'))));
  });
});

describe('exportar (R-5.5, AC-5.7, U-6)', () => {
  test('tema do vault: bytes iguais ao theme.json gravado; aviso STR-33 com o caminho', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.settings.saveNewTheme(draft('Meu Tema'));
    await h.app.settings.exportTheme();
    const [name, bytes] = h.platform.saveFile.mock.calls[0] ?? [];
    expect(name).toBe('meu-tema.theme.json');
    expect(sha(bytes ?? null)).toBe(sha(h.port.readBytes(themeFilePath('meu-tema'))));
    expect(h.app.store.getState().notices.at(-1)).toMatchObject({
      notice: 'theme-exported',
      text: 'Tema exportado para “/exportados/meu-tema.theme.json”.',
    });
  });

  test('embutido: o conjunto completo composto; cancelar não avisa; falha avisa', async () => {
    const h = await setup({ 'nota.md': NOTA }, { open: false });
    h.app.settings.setTheme('simplemd-dark');
    await h.app.settings.exportTheme();
    const bytes = h.platform.saveFile.mock.calls[0]?.[1];
    expect(new TextDecoder().decode(bytes)).toBe(serializeTheme(simplemdDark));
    const notices = h.app.store.getState().notices.length;
    h.platform.saveFile.mockResolvedValueOnce(null);
    await h.app.settings.exportTheme();
    expect(h.app.store.getState().notices).toHaveLength(notices);
    h.platform.saveFile.mockRejectedValueOnce(new Error('disco cheio'));
    await h.app.settings.exportTheme();
    expect(h.app.store.getState().notices.at(-1)).toMatchObject({
      kind: 'error',
      notice: 'theme-export-failed',
      text: 'Não foi possível exportar o tema.',
    });
  });
});

describe('temas inválidos no vault', () => {
  test('ficam de fora com um aviso que nomeia o id e o campo', async () => {
    const h = await setup({
      'nota.md': NOTA,
      [themeFilePath('ruim')]: '{"name":"R","base":"light","tokens":{"--bg":"#fff"}}',
    });
    expect(h.app.store.getState().userThemes).toEqual([]);
    expect(h.app.store.getState().notices.at(-1)).toMatchObject({
      notice: 'theme-invalid',
      detail: 'ruim: tokens.--bg',
    });
  });
});
