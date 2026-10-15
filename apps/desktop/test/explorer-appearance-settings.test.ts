import { createHash } from 'node:crypto';
import { DEFAULT_EXPLORER_APPEARANCE } from '@simplemd/themes';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PREFS_SAVE_DEBOUNCE_MS } from '../src/state/settings';
import { setup, type Harness } from './helpers';

/**
 * r13 S1 — `appearance.explorer` no `.simplemd/config.json` (arch-backend r13 §2–§3; D-R13-B1):
 * ler nunca grava; campo inválido = padrão + o aviso `config-field` que o nomeia; a seção só é
 * gravada quando o usuário muda, com os 4 campos e preservando o resto do arquivo.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const CONFIG = '.simplemd/config.json';
const NOTA = '# Nota\n';
const VAULT = { 'nota.md': NOTA, 'a/nota.md': NOTA };
const sha = (bytes: Uint8Array | null) =>
  bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const appearance = (h: Harness) => h.app.store.getState().explorerAppearance;
const fieldNotices = (h: Harness) =>
  h.app.store.getState().notices.filter((n) => n.notice === 'config-field');
const saved = (h: Harness) =>
  JSON.parse(h.port.readText(CONFIG) ?? '{}') as Record<string, unknown>;

describe('carregar (AC-13.7, AC-13.1)', () => {
  test('sem a seção: padrão (= r12), sem aviso e sem gravar', async () => {
    const h = await setup({ ...VAULT, [CONFIG]: '{"x":1}' });
    expect(appearance(h)).toEqual(DEFAULT_EXPLORER_APPEARANCE);
    expect(fieldNotices(h)).toEqual([]);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.writes()).toBe(0);
  });

  test('seção válida é lida e não regravada', async () => {
    const config =
      '{"appearance":{"explorer":{"style":"gradient","auto":"rainbow","intensity":"strong","scope":"inherit"}}}';
    const h = await setup({ ...VAULT, [CONFIG]: config });
    expect(appearance(h)).toEqual({
      style: 'gradient',
      auto: 'rainbow',
      intensity: 'strong',
      scope: 'inherit',
    });
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.writes()).toBe(0);
  });

  test('campos inválidos: só eles no padrão, 1 aviso config-field com os nomes, arquivo intacto', async () => {
    const config =
      '{"appearance":{"explorer":{"style":"Card","auto":"rainbow","intensity":3,"scope":"inherit"}}}';
    const h = await setup({ ...VAULT, [CONFIG]: config });
    const before = sha(h.port.readBytes(CONFIG));
    expect(appearance(h)).toEqual({
      style: 'dot',
      auto: 'rainbow',
      intensity: 'medium',
      scope: 'inherit',
    });
    const notices = fieldNotices(h);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: 'info',
      text: 'Valores inválidos em .simplemd/config.json foram trocados pelo padrão.',
      detail: 'appearance.explorer.style, appearance.explorer.intensity',
    });
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.writes()).toBe(0);
    expect(sha(h.port.readBytes(CONFIG))).toBe(before);
  });

  test('appearance que não é objeto: aviso com o campo; junto com outros campos num aviso só', async () => {
    const h = await setup({ ...VAULT, [CONFIG]: '{"appearance":3,"editor":{"captureTab":1}}' });
    expect(appearance(h)).toEqual(DEFAULT_EXPLORER_APPEARANCE);
    expect(fieldNotices(h).map((n) => n.detail)).toEqual(['editor.captureTab, appearance']);
  });
});

describe('gravar (D-R13-B1)', () => {
  test('mudar grava os 4 campos explícitos, preserva extras e as outras chaves; reabrir restaura', async () => {
    const h = await setup({
      ...VAULT,
      [CONFIG]: JSON.stringify({
        x: 1,
        folderColors: { a: 'blue' },
        appearance: { y: 2, explorer: { future: 'z' } },
      }),
    });
    h.app.settings.setExplorerAppearance({ style: 'card' });
    expect(appearance(h).style).toBe('card');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(saved(h)).toMatchObject({
      x: 1,
      folderColors: { a: 'blue' },
      appearance: {
        y: 2,
        explorer: { future: 'z', style: 'card', auto: 'off', intensity: 'medium', scope: 'own' },
      },
    });

    const again = await setup({ ...VAULT, [CONFIG]: h.port.readText(CONFIG) ?? '' });
    expect(appearance(again)).toEqual({ ...DEFAULT_EXPLORER_APPEARANCE, style: 'card' });
  });

  test('gravação por outra causa não toca appearance, nem um valor inválido', async () => {
    const h = await setup({
      ...VAULT,
      [CONFIG]: '{"appearance":{"explorer":{"style":"Card","auto":"rainbow"}}}',
    });
    h.app.settings.setTheme('simplemd-dark');
    h.app.settings.setFolderColor('a', 'pink');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(h.writes()).toBe(1);
    expect(saved(h)).toMatchObject({
      theme: 'simplemd-dark',
      folderColors: { a: 'pink' },
      appearance: { explorer: { style: 'Card', auto: 'rainbow' } },
    });
    expect(saved(h).appearance).toEqual({ explorer: { style: 'Card', auto: 'rainbow' } });

    const plain = await setup({ ...VAULT, [CONFIG]: '{"x":1}' });
    plain.app.settings.setTheme('simplemd-dark');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(saved(plain)).not.toHaveProperty('appearance');
  });

  test('appearance/explorer que não são objeto viram objeto ao mudar', async () => {
    const h = await setup({ ...VAULT, [CONFIG]: '{"appearance":3}' });
    h.app.settings.setExplorerAppearance({ auto: 'rainbow' });
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(saved(h).appearance).toEqual({
      explorer: { style: 'dot', auto: 'rainbow', intensity: 'medium', scope: 'own' },
    });
  });

  test('no-op: patch igual, campo inválido e config malformado não gravam', async () => {
    const h = await setup({ ...VAULT, [CONFIG]: '{"x":1}' });
    const before = appearance(h);
    h.app.settings.setExplorerAppearance({ style: 'dot', intensity: 'medium' });
    h.app.settings.setExplorerAppearance({ style: 'x' as never });
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.writes()).toBe(0);
    expect(appearance(h)).toBe(before);

    const bad = await setup({ ...VAULT, [CONFIG]: '{"appearance":' });
    bad.app.settings.setExplorerAppearance({ style: 'stripe' });
    expect(appearance(bad).style).toBe('stripe');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(bad.writes()).toBe(0);
  });
});

describe('sessão sem pasta (R-4.6)', () => {
  test('vale só na sessão; ao abrir a pasta vale o config; se a abertura falhar, volta', async () => {
    const h = await setup(
      { ...VAULT, [CONFIG]: '{"appearance":{"explorer":{"style":"stripe"}}}' },
      { open: false },
    );
    h.app.settings.setExplorerAppearance({ style: 'gradient', auto: 'rainbow' });
    expect(appearance(h)).toMatchObject({ style: 'gradient', auto: 'rainbow' });
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.writes()).toBe(0);

    await h.app.sync.openVault('welcome');
    expect(appearance(h)).toEqual({ ...DEFAULT_EXPLORER_APPEARANCE, style: 'stripe' });
    // A 1ª abertura que falha volta às boas-vindas com o que valia antes dela (UIF F-03).
    h.app.settings.reset();
    expect(appearance(h)).toMatchObject({ style: 'gradient', auto: 'rainbow' });
    h.app.settings.reset();
    expect(appearance(h)).toEqual(DEFAULT_EXPLORER_APPEARANCE);
  });
});
