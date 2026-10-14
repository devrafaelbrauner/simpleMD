// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { createHash } from 'node:crypto';
import { rainbowColors } from '@simplemd/themes';
import type * as ThemesModule from '@simplemd/themes';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/app/App';
import { setup } from './helpers';

/**
 * r13 S2 — estilo do explorador no app (arch-frontend r13 §1; D-R13-B2/P2/F1): o arco-íris é
 * derivado no `Shell` e só chega ao explorador; as abas não mudam; o config não é tocado.
 */
// Espião de passagem: conta as chamadas sem mudar o resultado (arch-frontend §6).
vi.mock('@simplemd/themes', async (importOriginal) => {
  const mod = await importOriginal<typeof ThemesModule>();
  return { ...mod, rainbowColors: vi.fn(mod.rainbowColors) };
});

// O jsdom não faz layout: a área do explorador passa a medir 240 × 600 (linhas visíveis).
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(240);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const CONFIG = '.simplemd/config.json';
const NOTA = '# Nota\n';
const TOP = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
const sha = (bytes: Uint8Array | null) =>
  bytes === null ? null : createHash('sha256').update(bytes).digest('hex');

/** 10 pastas no topo (AC-13.4), `b` com verde próprio, uma subpasta em `a` e uma oculta. */
function vault(explorer: Record<string, string> | null): Record<string, string> {
  const files: Record<string, string> = {
    'raiz.md': NOTA,
    'a/sub/n.md': NOTA,
    '.oculta/x.md': NOTA,
  };
  for (const name of TOP) files[`${name}/nota.md`] = NOTA;
  files[CONFIG] = JSON.stringify({
    folderColors: { b: 'green' },
    ...(explorer ? { appearance: { explorer } } : {}),
  });
  return files;
}

async function shell(files: Record<string, string>) {
  const h = await setup(files);
  render(<App app={h.app} />);
  await act(async () => {
    for (const path of ['a/nota.md', 'b/nota.md', 'a/sub/n.md', 'raiz.md'])
      await h.app.sync.openFile(path);
  });
  return h;
}

const tree = () => screen.getByRole('tree');
const tabBar = () => screen.getByRole('tablist');
/** [pasta, nome da bolinha] das pastas do topo visíveis. */
const dots = () =>
  screen
    .getAllByRole('treeitem')
    .filter((row) => row.dataset.kind === 'dir' && !row.dataset.path?.includes('/'))
    .map((row) => [
      row.dataset.path,
      row.querySelector('.smd-folder-dot')?.getAttribute('aria-label') ?? null,
    ]);

describe('arco-íris nas pastas do topo (AC-13.4, AC-13.5, D-R13-P1)', () => {
  test('1ª–8ª nas 8 cores, 9ª vermelha, 10ª laranja; b mantém o verde e ocupa a posição; config intacto', async () => {
    const h = await shell(vault({ auto: 'rainbow' }));
    const before = sha(h.port.readBytes(CONFIG));
    expect(dots()).toEqual([
      ['a', 'cor vermelha, automática'],
      ['b', 'cor verde'],
      ['c', 'cor âmbar, automática'],
      ['d', 'cor verde, automática'],
      ['e', 'cor azul-petróleo, automática'],
      ['f', 'cor azul, automática'],
      ['g', 'cor violeta, automática'],
      ['h', 'cor rosa, automática'],
      ['i', 'cor vermelha, automática'],
      ['j', 'cor laranja, automática'],
    ]);
    // Nunca grava: nem a cor automática em folderColors, nem o arquivo.
    expect([...h.app.store.getState().folderColors]).toEqual([['b', 'green']]);
    await act(async () => {
      const waited = Promise.withResolvers<void>();
      setTimeout(waited.resolve, 400);
      await waited.promise;
    });
    expect(h.writes()).toBe(0);
    expect(sha(h.port.readBytes(CONFIG))).toBe(before);
  });

  test('pasta nova no topo: a sequência é recalculada com a listagem, sem aviso', async () => {
    const h = await shell(vault({ auto: 'rainbow' }));
    const notices = h.app.store.getState().notices.length;
    h.port.externalWrite('bb/nova.md', NOTA);
    await act(async () => {
      await h.app.sync.refreshList();
    });
    expect(dots().slice(0, 4)).toEqual([
      ['a', 'cor vermelha, automática'],
      ['b', 'cor verde'],
      ['bb', 'cor âmbar, automática'],
      ['c', 'cor verde, automática'],
    ]);
    expect(h.app.store.getState().notices).toHaveLength(notices);
  });

  test('desligado: nenhuma bolinha automática e 0 chamadas a rainbowColors', async () => {
    const spy = vi.mocked(rainbowColors);
    spy.mockClear();
    const h = await shell(vault(null));
    expect(dots().filter(([, label]) => label !== null)).toEqual([['b', 'cor verde']]);
    expect(spy).not.toHaveBeenCalled();
    act(() => h.app.store.getState().activate('a/nota.md'));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('abas não mudam (AC-13.11, D-R13-P2, NFR-13.10)', () => {
  test('a barra de abas é a mesma com o arco-íris e o estilo ligados ou desligados', async () => {
    const h = await shell(vault(null));
    const off = tabBar().innerHTML;
    act(() =>
      h.app.settings.setExplorerAppearance({
        auto: 'rainbow',
        style: 'gradient',
        scope: 'inherit',
      }),
    );
    expect(dots()[0]).toEqual(['a', 'cor vermelha, automática']);
    expect(tabBar().innerHTML).toBe(off);
    // A aba de `a/` (só cor automática) segue sem cor; a de `b/` segue com o verde próprio.
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.dataset.folderColor ?? null)).toEqual([null, 'green', null, null]);
  });

  test('trocar de aba não recalcula o arco-íris', async () => {
    const h = await shell(vault({ auto: 'rainbow' }));
    const spy = vi.mocked(rainbowColors);
    spy.mockClear();
    act(() => h.app.store.getState().activate('a/nota.md'));
    act(() => h.app.store.getState().activate('raiz.md'));
    expect(screen.getAllByRole('tab')[3]?.getAttribute('aria-selected')).toBe('true');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('aplicar na hora (AC-13.2, NFR-13.7)', () => {
  test('mudar o estilo muda o atributo da árvore no mesmo render; Bolinha volta ao DOM de main', async () => {
    const h = await shell(vault(null));
    expect(tree().hasAttribute('data-explorer-style')).toBe(false);
    act(() => h.app.settings.setExplorerAppearance({ style: 'card' }));
    expect(tree().dataset.explorerStyle).toBe('card');
    expect(tree().dataset.explorerIntensity).toBe('medium');
    act(() => h.app.settings.setExplorerAppearance({ intensity: 'subtle' }));
    expect(tree().dataset.explorerIntensity).toBe('subtle');
    expect(screen.getByRole('treeitem', { name: /^b ?cor verde$/ }).dataset.folderSource).toBe(
      'own',
    );
    act(() => h.app.settings.setExplorerAppearance({ style: 'dot' }));
    expect(tree().hasAttribute('data-explorer-style')).toBe(false);
    expect(tree().querySelector('[data-folder-source]')).toBeNull();
  });

  test('"Também subpastas" só pinta herdeiras fora de Bolinha (escopo efetivo own em Bolinha)', async () => {
    const h = await shell(vault({ auto: 'rainbow', scope: 'inherit' }));
    act(() => h.app.store.setState({ expanded: { a: true } }));
    const sub = () => screen.getByRole('treeitem', { name: 'sub' });
    expect(sub().hasAttribute('data-folder-source')).toBe(false);
    act(() => h.app.settings.setExplorerAppearance({ style: 'stripe' }));
    expect(sub().dataset.folderSource).toBe('inherited');
    expect(sub().dataset.folderColor).toBe('red');
    expect(sub().querySelector('.smd-folder-dot')).toBeNull();
  });
});
