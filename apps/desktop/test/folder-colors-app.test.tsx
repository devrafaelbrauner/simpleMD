// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { resolveFolderColor } from '@simplemd/themes';
import type * as ThemesModule from '@simplemd/themes';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/app/App';
import { setup, type Harness } from './helpers';

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

describe('comandos "Pasta: …" na paleta (r12 S4: AC-12.1, AC-12.2, AC-12.3, NFR-12.8)', () => {
  // O jsdom não faz layout: a área do explorador passa a medir 240 × 600 (linhas visíveis).
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(240);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const SET = '[data-command-id="app:folder-set-color"]';
  const REMOVE = '[data-command-id="app:folder-remove-color"]';
  const input = () => screen.getByTestId('palette-input') as HTMLInputElement;

  function openPalette(h: Harness, focused: string | null) {
    act(() => {
      h.app.store.setState({
        expanded: { Projetos: true, 'Projetos/b': true },
        focusedPath: focused,
      });
      h.app.store.setState({ paletteOpen: true, palettePrefill: '' });
    });
    return screen.getByTestId('palette');
  }

  async function nextFrame() {
    await act(async () => {
      const frame = Promise.withResolvers<number>();
      requestAnimationFrame(frame.resolve);
      await frame.promise;
    });
  }

  test('sem pasta focada (nada ou uma nota) os 2 comandos não aparecem', async () => {
    const h = await shell();
    for (const focused of [null, 'Projetos/x.md']) {
      const palette = openPalette(h, focused);
      expect(palette.querySelector(SET)).toBeNull();
      expect(palette.querySelector(REMOVE)).toBeNull();
      fireEvent.keyDown(input(), { key: 'Escape' });
    }
  });

  test('pasta focada: detalhe com o caminho; remover desabilitado com o motivo certo', async () => {
    const h = await shell({ ...VAULT, 'Outra/o.md': NOTA });
    let palette = openPalette(h, 'Projetos/b');
    expect(palette.querySelector(SET)?.textContent).toBe('Pasta: definir cor…pasta “Projetos/b”');
    expect(palette.querySelector(REMOVE)?.getAttribute('aria-disabled')).toBe('true');
    expect(palette.querySelector(REMOVE)?.textContent).toContain('A cor vem de “Projetos”.');
    fireEvent.keyDown(input(), { key: 'Escape' });
    palette = openPalette(h, 'Outra');
    expect(palette.querySelector(REMOVE)?.textContent).toContain('Esta pasta não tem cor própria.');
    fireEvent.keyDown(input(), { key: 'Escape' });
    palette = openPalette(h, 'Projetos');
    expect(palette.querySelector(REMOVE)?.getAttribute('aria-disabled')).toBeNull();
  });

  test('só teclado: definir → filtro → Enter pinta pasta, herdeiras e aba no mesmo quadro; anúncio', async () => {
    const h = await shell();
    openPalette(h, 'Projetos/b');
    fireEvent.change(input(), { target: { value: 'definir cor' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input().placeholder).toBe('Cor para “b”…');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'Vermelho',
      'Laranja',
      'Âmbar',
      'Verde',
      'Azul-petróleo',
      'Azul',
      'Violeta',
      'Rosa',
    ]);
    fireEvent.change(input(), { target: { value: 'viol' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(screen.queryByTestId('palette')).toBeNull();
    await nextFrame();
    expect([...h.app.store.getState().folderColors]).toContainEqual(['Projetos/b', 'violet']);
    expect(labels()[1]).toBe('y.md · pasta b, cor violeta');
    const nav = screen.getByRole('navigation', { name: 'Arquivos' });
    within(nav).getByRole('img', { name: 'cor violeta' });
    expect(nav.querySelector('p.sr-only[role=status]')?.textContent).toBe(
      'Pasta “b”: cor violeta.',
    );

    // Trocar: a cor atual vem marcada e é a opção ativa ao entrar no passo.
    openPalette(h, 'Projetos/b');
    fireEvent.change(input(), { target: { value: 'definir cor' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    const current = screen.getAllByRole('option').find((o) => o.textContent?.includes('cor atual'));
    expect(current?.dataset.commandId).toBe('violet');
    expect(current?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input(), { key: 'Escape' });
  });

  test('Esc no 2º passo: nada muda e nada é gravado', async () => {
    const h = await shell();
    const before = h.app.store.getState().folderColors;
    openPalette(h, 'Projetos/b');
    fireEvent.change(input(), { target: { value: 'definir cor' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Escape' });
    await nextFrame();
    expect(screen.queryByTestId('palette')).toBeNull();
    expect(h.app.store.getState().folderColors).toBe(before);
  });

  test('remover: volta à cor herdada (ou a main) no mesmo quadro; anúncio', async () => {
    const h = await shell();
    openPalette(h, 'Projetos/b/Clientes');
    fireEvent.change(input(), { target: { value: 'remover cor' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await nextFrame();
    expect(labels()[2]).toBe('z.md · pasta Projetos, cor azul');
    const nav = screen.getByRole('navigation', { name: 'Arquivos' });
    expect(within(nav).queryByRole('img', { name: 'cor verde' })).toBeNull();
    expect(nav.querySelector('p.sr-only[role=status]')?.textContent).toBe(
      'Pasta “Clientes”: sem cor própria.',
    );
  });
});
