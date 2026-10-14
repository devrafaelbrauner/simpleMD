import { createHash } from 'node:crypto';
import { FOLDER_COLORS_MAX } from '@simplemd/themes';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PREFS_SAVE_DEBOUNCE_MS } from '../src/state/settings';
import { setup, type Harness } from './helpers';

/**
 * r12 S2 — `folderColors` no `.simplemd/config.json` (arch-backend r12 §2–§4; D-R12-B1/B2/08):
 * ler nunca grava; inválidas e órfãs ignoradas com 1 aviso próprio (STR-R12-03); gravar mescla e
 * poda só numa gravação.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const CONFIG = '.simplemd/config.json';
const NOTA = '# Nota\n';
const LOAD_TEXT =
  'Algumas cores de pasta em .simplemd/config.json foram ignoradas. O arquivo não foi alterado.';
const sha = (bytes: Uint8Array | null) =>
  bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const VAULT = {
  'nota.md': NOTA,
  'a/nota.md': NOTA,
  'a/b/c/nota.md': NOTA,
  'b/nota.md': NOTA,
  'c/nota.md': NOTA,
};
const colors = (h: Harness) => [...h.app.store.getState().folderColors];
const folderNotices = (h: Harness) =>
  h.app.store.getState().notices.filter((n) => n.notice === 'folder-colors');

describe('carregar (AC-12.6, AC-12.7, NFR-12.7)', () => {
  test('inválidas e caminho inexistente: ignoradas, 1 aviso próprio, arquivo intacto', async () => {
    const config = JSON.stringify({
      x: 1,
      folderColors: { a: 'blue', 'a/b/c': 'green', sumiu: 'red', b: 'roxo', c: '#00ff00' },
    });
    const h = await setup({ ...VAULT, [CONFIG]: config });
    const before = sha(h.port.readBytes(CONFIG));
    expect(colors(h)).toEqual([
      ['a', 'blue'],
      ['a/b/c', 'green'],
    ]);
    const notices = folderNotices(h);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: 'info',
      text: LOAD_TEXT,
      detail:
        'folderColors["b"]: cor desconhecida “roxo”; folderColors["c"]: use um nome de cor, não hex; folderColors["sumiu"]: a pasta não existe',
    });
    // D-R12-08: não se mistura com o aviso `config-field` existente.
    expect(h.app.store.getState().notices.some((n) => n.notice === 'config-field')).toBe(false);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.writes()).toBe(0);
    expect(sha(h.port.readBytes(CONFIG))).toBe(before);
  });

  test('folderColors que não é objeto: 1 aviso; ausente: nenhum aviso', async () => {
    const bad = await setup({ ...VAULT, [CONFIG]: '{"folderColors":["a"]}' });
    expect(folderNotices(bad).map((n) => n.detail)).toEqual(['folderColors: deve ser um objeto']);
    const none = await setup({ ...VAULT, [CONFIG]: '{"x":1}' });
    expect(folderNotices(none)).toEqual([]);
    expect(colors(none)).toEqual([]);
  });

  test('mais de 500 entradas: as 500 primeiras valem, 1 aviso com o excesso, sem gravar', async () => {
    const files: Record<string, string> = { 'nota.md': NOTA };
    const entries: Record<string, string> = {};
    for (let i = 0; i <= FOLDER_COLORS_MAX; i++) {
      files[`p${i}/nota.md`] = NOTA;
      entries[`p${i}`] = 'teal';
    }
    const h = await setup({ ...files, [CONFIG]: JSON.stringify({ folderColors: entries }) });
    expect(colors(h)).toHaveLength(FOLDER_COLORS_MAX);
    expect(folderNotices(h).map((n) => n.detail)).toEqual([
      'folderColors: mais de 500 entradas; as excedentes foram ignoradas',
    ]);
    expect(h.writes()).toBe(0);
  });

  test('detalhe longo: corta em 10 entradas + "e mais N"', async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 12; i++) entries[`x${i}`] = 'roxo';
    const h = await setup({ ...VAULT, [CONFIG]: JSON.stringify({ folderColors: entries }) });
    const detail = folderNotices(h)[0]?.detail ?? '';
    expect(detail.split('; ')).toHaveLength(11);
    expect(detail.endsWith('; e mais 2')).toBe(true);
  });
});

describe('gravar (AC-12.6, AC-12.9 poda; D-R12-B2)', () => {
  test('definir grava só o id e preserva as outras chaves; reabrir restaura', async () => {
    const h = await setup({ ...VAULT, [CONFIG]: '{"x":1,"editor":{"y":2}}' });
    h.app.settings.setFolderColor('a', 'blue');
    expect(colors(h)).toEqual([['a', 'blue']]);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    const saved = JSON.parse(h.port.readText(CONFIG) ?? '') as Record<string, unknown>;
    expect(saved).toMatchObject({ x: 1, editor: { y: 2 }, folderColors: { a: 'blue' } });

    const again = await setup({ ...VAULT, [CONFIG]: h.port.readText(CONFIG) ?? '' });
    expect(colors(again)).toEqual([['a', 'blue']]);
    expect(folderNotices(again)).toEqual([]);
  });

  test('trocar mantém a posição; remover a última apaga a seção', async () => {
    const h = await setup({ ...VAULT, [CONFIG]: '{"folderColors":{"a":"blue","b":"red"}}' });
    h.app.settings.setFolderColor('a', 'pink');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(h.port.readText(CONFIG)).toContain(
      '"folderColors": {\n    "a": "pink",\n    "b": "red"',
    );
    h.app.settings.removeFolderColor('a');
    h.app.settings.removeFolderColor('b');
    expect(colors(h)).toEqual([]);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(JSON.parse(h.port.readText(CONFIG) ?? '')).not.toHaveProperty('folderColors');
  });

  test('no-op: arquivo, pasta inexistente, mesma cor, remover sem cor própria', async () => {
    const h = await setup({ ...VAULT, [CONFIG]: '{"folderColors":{"a":"blue"}}' });
    h.app.settings.setFolderColor('nota.md', 'red');
    h.app.settings.setFolderColor('nao-existe', 'red');
    h.app.settings.setFolderColor('a', 'blue');
    h.app.settings.removeFolderColor('b');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.writes()).toBe(0);
    expect(colors(h)).toEqual([['a', 'blue']]);
  });

  test('órfã e inválida saem na próxima gravação de outra causa; sem a seção, ela não aparece', async () => {
    const h = await setup({
      ...VAULT,
      [CONFIG]: '{"folderColors":{"a":"blue","sumiu":"red","b":"roxo"}}',
    });
    h.app.settings.setTheme('simplemd-dark');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(JSON.parse(h.port.readText(CONFIG) ?? '')).toMatchObject({
      theme: 'simplemd-dark',
      folderColors: { a: 'blue' },
    });
    expect(JSON.parse(h.port.readText(CONFIG) ?? '').folderColors).toEqual({ a: 'blue' });

    const plain = await setup({ ...VAULT, [CONFIG]: '{"x":1}' });
    plain.app.settings.setTheme('simplemd-dark');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(JSON.parse(plain.port.readText(CONFIG) ?? '')).not.toHaveProperty('folderColors');
  });

  test('config.json malformado: a cor vale na sessão e o arquivo nunca é gravado', async () => {
    const h = await setup({ ...VAULT, [CONFIG]: '{"folderColors":' });
    h.app.settings.setFolderColor('a', 'green');
    expect(colors(h)).toEqual([['a', 'green']]);
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.writes()).toBe(0);
  });
});

describe('mapa efetivo (contrato com o frontend; NFR-12.5)', () => {
  test('relistar sem mudança mantém a mesma referência do mapa', async () => {
    const h = await setup({ ...VAULT, [CONFIG]: '{"folderColors":{"a":"blue"}}' });
    const map = h.app.store.getState().folderColors;
    h.port.externalWrite('d/nova.md', NOTA);
    await h.app.sync.refreshList();
    expect(h.app.store.getState().entries.some((e) => e.path === 'd')).toBe(true);
    expect(h.app.store.getState().folderColors).toBe(map);
  });

  test('fechar a pasta (voltar às boas-vindas) limpa as cores', async () => {
    const h = await setup({ ...VAULT, [CONFIG]: '{"folderColors":{"a":"blue"}}' });
    h.app.settings.reset();
    expect(colors(h)).toEqual([]);
  });
});
