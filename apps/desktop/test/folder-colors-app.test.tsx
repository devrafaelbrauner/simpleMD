// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { resolveFolderColor } from '@simplemd/themes';
import type * as ThemesModule from '@simplemd/themes';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/app/App';
import { setup } from './helpers';

// Espião de passagem: conta as chamadas sem mudar o resultado (D-R12-F1, NFR-12.5).
vi.mock('@simplemd/themes', async (importOriginal) => {
  const mod = await importOriginal<typeof ThemesModule>();
  return { ...mod, resolveFolderColor: vi.fn(mod.resolveFolderColor) };
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

const CONFIG = '.simplemd/config.json';
const NOTA = '# Nota\n';
const VAULT = {
  'Projetos/x.md': NOTA,
  'Projetos/b/y.md': NOTA,
  'Projetos/b/Clientes/z.md': NOTA,
  'raiz.md': NOTA,
  [CONFIG]: JSON.stringify({ folderColors: { Projetos: 'blue', 'Projetos/b/Clientes': 'green' } }),
};
const labels = () => screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'));

async function shell(files: Record<string, string> = VAULT) {
  const h = await setup(files);
  render(<App app={h.app} />);
  await act(async () => {
    for (const path of ['Projetos/x.md', 'Projetos/b/y.md', 'Projetos/b/Clientes/z.md', 'raiz.md'])
      await h.app.sync.openFile(path);
  });
  return h;
}

describe('aba colorida pela pasta (r12 S3: AC-12.4, AC-12.5)', () => {
  test('herança da pasta colorida mais próxima; a raiz fica sem cor; origem = pasta que define', async () => {
    await shell();
    expect(labels()).toEqual([
      'x.md · pasta Projetos, cor azul',
      'y.md · pasta Projetos, cor azul',
      'z.md · pasta Clientes, cor verde',
      'raiz.md',
    ]);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.dataset.folderColor ?? null)).toEqual([
      'blue',
      'blue',
      'green',
      null,
    ]);
  });

  test('trocar de aba não recalcula a cor (0 chamadas a resolveFolderColor)', async () => {
    const h = await shell();
    const spy = vi.mocked(resolveFolderColor);
    spy.mockClear();
    act(() => h.app.store.getState().activate('Projetos/x.md'));
    act(() => h.app.store.getState().activate('Projetos/b/Clientes/z.md'));
    expect(screen.getAllByRole('tab')[2]?.getAttribute('aria-selected')).toBe('true');
    expect(spy).not.toHaveBeenCalled();
  });

  test('definir e remover cor muda as abas herdeiras no mesmo render; remover volta a main', async () => {
    const h = await shell();
    act(() => h.app.settings.setFolderColor('Projetos/b', 'violet'));
    expect(labels()).toEqual([
      'x.md · pasta Projetos, cor azul',
      'y.md · pasta b, cor violeta',
      'z.md · pasta Clientes, cor verde',
      'raiz.md',
    ]);
    act(() => {
      h.app.settings.removeFolderColor('Projetos/b');
      h.app.settings.removeFolderColor('Projetos');
    });
    expect(labels()).toEqual(['x.md', 'y.md', 'z.md · pasta Clientes, cor verde', 'raiz.md']);
    expect(screen.getAllByRole('tab')[0]?.querySelector('.smd-folder-dot, .smd-tab-origin')).toBe(
      null,
    );
  });
});
