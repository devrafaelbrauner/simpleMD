import { resolveFolderColor } from '@simplemd/themes';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PREFS_SAVE_DEBOUNCE_MS } from '../src/state/settings';
import { setup, type Harness } from './helpers';

/**
 * r12 S6 — pasta colorida renomeada, movida ou apagada FORA do app com ele aberto (AC-12.9,
 * D-R12-P8, arch-backend §4): em ≤ 2 s abas e explorador perdem a cor própria (herdam a de cima),
 * sem erro, com 1 aviso por lote (STR-R12-04); nome novo não herda; a órfã sai só na próxima
 * gravação do config. Renomear = `remove` + `externalWrite` (as duas ordens).
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const CONFIG = '.simplemd/config.json';
const NOTA = '# Nota\n';
const BUDGET_MS = 2_000;
const VAULT = {
  'Projetos/x.md': NOTA,
  'Projetos/Pesquisa/leituras.md': NOTA,
  'Projetos/Pesquisa/Artigos/a.md': NOTA,
  'Financeiro/f.md': NOTA,
  [CONFIG]: JSON.stringify({
    x: 1,
    folderColors: {
      Projetos: 'blue',
      'Projetos/Pesquisa': 'amber',
      'Projetos/Pesquisa/Artigos': 'green',
      Financeiro: 'red',
    },
  }),
};

const gone = (h: Harness) =>
  h.app.store.getState().notices.filter((n) => n.notice === 'folder-colors-gone');
const colorOf = (h: Harness, path: string) =>
  resolveFolderColor(h.app.store.getState().folderColors, path);

/** Avança o relógio em passos de 50 ms até `done()`; devolve o tempo gasto (≤ orçamento). */
async function elapsedUntil(done: () => boolean): Promise<number> {
  const start = Date.now();
  while (!done() && Date.now() - start <= BUDGET_MS) await vi.advanceTimersByTimeAsync(50);
  return Date.now() - start;
}

describe('pasta colorida some fora do app (AC-12.9)', () => {
  test.each([
    ['remove → add', ['remove', 'add'] as const],
    ['add → remove', ['add', 'remove'] as const],
  ])(
    'renomear (%s): ≤ 2 s sem a cor própria, herda a de cima, 1 aviso, nome novo sem cor',
    async (_, order) => {
      const h = await setup(VAULT);
      await h.app.sync.openFile('Projetos/Pesquisa/leituras.md');
      const before = h.port.readText(CONFIG);
      expect(colorOf(h, 'Projetos/Pesquisa/leituras.md')).toEqual({
        folder: 'Projetos/Pesquisa',
        id: 'amber',
      });
      for (const step of order) {
        if (step === 'remove') h.port.remove('Projetos/Pesquisa');
        else h.port.externalWrite('Projetos/Leituras/leituras.md', NOTA);
      }
      const ms = await elapsedUntil(
        () => !h.app.store.getState().folderColors.has('Projetos/Pesquisa'),
      );
      expect(ms).toBeLessThanOrEqual(BUDGET_MS);
      await h.settle();
      const colors = h.app.store.getState().folderColors;
      expect([...colors.keys()].sort()).toEqual(['Financeiro', 'Projetos']);
      // A aba aberta (mesmo apagada) herda a cor de cima; o nome novo também herda só a de cima.
      expect(colorOf(h, 'Projetos/Pesquisa/leituras.md')).toEqual({
        folder: 'Projetos',
        id: 'blue',
      });
      expect(colorOf(h, 'Projetos/Leituras/leituras.md')).toEqual({
        folder: 'Projetos',
        id: 'blue',
      });
      expect(colors.has('Projetos/Leituras')).toBe(false);
      // 1 aviso para o lote (a pasta e a subpasta colorida dentro dela), nunca um erro.
      expect(gone(h)).toHaveLength(1);
      expect(gone(h)[0]).toMatchObject({
        kind: 'info',
        text: '2 pastas com cor não existem mais.',
        detail: 'Projetos/Pesquisa; Projetos/Pesquisa/Artigos',
      });
      expect(h.app.store.getState().notices.some((n) => n.kind === 'error')).toBe(false);
      // Nunca reescreve o config só por isso.
      await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
      expect(h.port.readText(CONFIG)).toBe(before);
    },
  );

  test('apagar 1 pasta colorida: aviso no singular com o caminho; relistar de novo não repete', async () => {
    const h = await setup(VAULT);
    h.port.remove('Financeiro');
    await elapsedUntil(() => !h.app.store.getState().folderColors.has('Financeiro'));
    expect(gone(h).map((n) => n.text)).toEqual([
      'A pasta “Financeiro” tinha cor e não existe mais.',
    ]);
    h.port.externalWrite('outra/n.md', NOTA);
    await h.app.sync.refreshList();
    await h.settle();
    expect(gone(h)).toHaveLength(1);
  });

  test('aviso dispensado não volta na relistagem seguinte (code-review N2)', async () => {
    const h = await setup(VAULT);
    h.port.remove('Financeiro');
    await h.app.sync.refreshList();
    await h.settle();
    expect(gone(h)).toHaveLength(1);
    h.app.store.getState().dismissNoticeKey('folder-colors-gone');
    expect(gone(h)).toHaveLength(0);
    h.port.externalWrite('outra/n.md', NOTA);
    await h.app.sync.refreshList();
    await h.settle();
    expect(gone(h)).toHaveLength(0);
  });

  test('órfã sai na próxima gravação de outra causa; recriada antes disso, a cor volta', async () => {
    const h = await setup(VAULT);
    h.port.remove('Financeiro');
    await elapsedUntil(() => !h.app.store.getState().folderColors.has('Financeiro'));
    h.port.externalWrite('Financeiro/f.md', NOTA);
    await elapsedUntil(() => h.app.store.getState().folderColors.has('Financeiro'));
    expect(h.app.store.getState().folderColors.get('Financeiro')).toBe('red');

    h.port.remove('Financeiro');
    await elapsedUntil(() => !h.app.store.getState().folderColors.has('Financeiro'));
    h.app.settings.setTheme('simplemd-dark');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    const saved = JSON.parse(h.port.readText(CONFIG) ?? '') as { folderColors: object };
    expect(saved.folderColors).toEqual({
      Projetos: 'blue',
      'Projetos/Pesquisa': 'amber',
      'Projetos/Pesquisa/Artigos': 'green',
    });
    // Podada: recriar a pasta agora não traz a cor de volta.
    h.port.externalWrite('Financeiro/f.md', NOTA);
    await h.app.sync.refreshList();
    expect(h.app.store.getState().folderColors.has('Financeiro')).toBe(false);
  });

  test('pasta sem cor some: nenhum aviso de cor', async () => {
    const h = await setup({ ...VAULT, 'Solta/s.md': NOTA });
    h.port.remove('Solta');
    await h.app.sync.refreshList();
    await h.settle();
    expect(gone(h)).toEqual([]);
  });
});
