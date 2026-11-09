// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { CONFIG_PATH } from '@simplemd/themes';
import { buildSearchKeys, filterKeys } from '@simplemd/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/app/App';
import { PREFS_SAVE_DEBOUNCE_MS } from '../src/state/settings';
import { setup, type Harness } from './helpers';

/**
 * r36c (AC-R36C-1, AC-R36-3; design-r36 §4–5): Configurações → "Pasta" liga e desliga
 * `index.cloudOnly` pelo store — o `config.json` em 300 ms e, ligada, o índice baixa e relê as
 * notas só na nuvem, com "Baixando N notas…" na seção enquanto isso (code-review r36b, item 5) —,
 * mostra o valor da pasta e, sem pasta, fica `aria-disabled` com o motivo. A busca do catálogo acha
 * as `#tags` do corpo tiradas pelo extrator real.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NAME = 'Indexar notas só na nuvem';
const BOLO = '---\ntitle: Bolo de fubá\ntags: [receita, doce]\n---\n# Bolo\n';

/** Deixa a construção do índice terminar (fatias de 25 notas entre tarefas de 0 ms). */
async function settleIndex(h: Harness) {
  for (let i = 0; i < 200 && h.app.catalog.getSnapshot().status !== 'ready'; i++)
    await act(() => vi.advanceTimersByTimeAsync(1));
}

/** Pasta aberta com `cloud` só na nuvem, o app na tela e o índice pronto. */
async function openApp(files: Record<string, string>, cloud: readonly string[]): Promise<Harness> {
  const h = await setup(files, { catalog: true, open: false });
  for (const path of cloud) h.port.setCloudOnly(path);
  await h.app.sync.openVault('welcome');
  render(<App app={h.app} />);
  await settleIndex(h);
  return h;
}

/** Configurações abertas em "Pasta" (como pela aba): devolve o interruptor. */
function openFolderSection(h: Harness): HTMLElement {
  act(() => h.app.store.setState({ settingsOpen: true, settingsSection: 'folder' }));
  return screen.getByRole('switch', { name: NAME });
}

const switchState = () =>
  document.querySelector('[data-testid="settings-folder"] .smd-switch-state')?.textContent;
const downloading = () => screen.queryByTestId('set-index-cloud-downloading')?.textContent;

describe('AC-R36C-1: Configurações → "Pasta" → "Indexar notas só na nuvem"', () => {
  test('desligado por padrão; ligar anuncia, grava index.cloudOnly em 300 ms e o índice baixa e relê a nota ("Baixando 1 nota…" enquanto isso); desligar grava false', async () => {
    const h = await openApp({ 'receitas/bolo.md': BOLO, 'a.md': '# A\n' }, ['receitas/bolo.md']);
    const bolo = () =>
      h.app.catalog.getSnapshot().entries.find((e) => e.path === 'receitas/bolo.md');
    expect(bolo()).toMatchObject({ title: 'bolo', tags: [], cloud: true });
    expect(
      h.port.calls().filter((c) => c.op === 'readFile' && c.abs === '/vault/receitas/bolo.md'),
    ).toEqual([]);

    const toggle = openFolderSection(h);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.hasAttribute('aria-disabled')).toBe(false);
    expect(switchState()).toBe('Desligado');
    expect(downloading()).toBeUndefined();

    // O download da nota (a leitura) leva 1 s.
    h.port.fault({ op: 'readFile', path: 'receitas/bolo.md', delayMs: 1000, once: true });
    fireEvent.click(toggle);
    expect(h.app.store.getState().indexCloudOnly).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(switchState()).toBe('Ligado');
    expect(screen.getByTestId('settings-live').textContent).toBe(
      'Indexar notas só na nuvem ligado. As notas desta pasta que estão só na nuvem vão ser baixadas para indexar.',
    );
    expect(downloading()).toBe('Baixando 1 nota da nuvem para indexar…');
    expect(h.port.readText(CONFIG_PATH)).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS));
    expect(JSON.parse(h.port.readText(CONFIG_PATH) ?? '{}').index).toEqual({ cloudOnly: true });
    expect(downloading()).toBe('Baixando 1 nota da nuvem para indexar…');

    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(bolo()).toMatchObject({ title: 'Bolo de fubá', tags: ['receita', 'doce'] });
    expect(bolo()).not.toHaveProperty('cloud');
    expect(
      h.port.calls().filter((c) => c.op === 'readFile' && c.abs === '/vault/receitas/bolo.md'),
    ).toHaveLength(1);
    expect(downloading()).toBeUndefined();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(switchState()).toBe('Desligado');
    expect(screen.getByTestId('settings-live').textContent).toBe(
      'Indexar notas só na nuvem desligado.',
    );
    await act(() => vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS));
    expect(JSON.parse(h.port.readText(CONFIG_PATH) ?? '{}').index).toEqual({ cloudOnly: false });
    // Desligar não apaga o que já foi lido.
    expect(bolo()).toMatchObject({ title: 'Bolo de fubá' });
  });

  test('index.cloudOnly: true no config.json da pasta: a seção abre em "Ligado", sem nada a baixar', async () => {
    const h = await openApp({ 'bolo.md': BOLO, [CONFIG_PATH]: '{"index":{"cloudOnly":true}}' }, [
      'bolo.md',
    ]);
    const toggle = openFolderSection(h);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(switchState()).toBe('Ligado');
    expect(downloading()).toBeUndefined();
    expect(h.app.catalog.getSnapshot().entries[0]).toMatchObject({ title: 'Bolo de fubá' });
  });

  test('code-review r36b item 5: ligada no meio da construção, a releitura do fim ("Indexando… 2 de 2") aparece na seção como "Baixando 1 nota…"', async () => {
    const h = await setup(
      { 'receitas/bolo.md': BOLO, 'a.md': '# A\n' },
      { catalog: true, open: false },
    );
    h.port.setCloudOnly('receitas/bolo.md');
    // A nota local leva 1 s (a construção segue em andamento) e o download da outra, mais 1 s.
    h.port.fault({ op: 'readFile', path: 'a.md', delayMs: 1000, once: true });
    h.port.fault({ op: 'readFile', path: 'receitas/bolo.md', delayMs: 1000, once: true });
    await h.app.sync.openVault('welcome');
    render(<App app={h.app} />);
    await act(() => vi.advanceTimersByTimeAsync(5));
    expect(h.app.catalog.getSnapshot()).toMatchObject({ status: 'building', done: 0, total: 2 });

    fireEvent.click(openFolderSection(h));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(h.app.catalog.getSnapshot()).toMatchObject({ status: 'building', done: 2, total: 2 });
    expect(downloading()).toBe('Baixando 1 nota da nuvem para indexar…');

    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(h.app.catalog.getSnapshot().status).toBe('ready');
    expect(downloading()).toBeUndefined();
    expect(
      h.app.catalog.getSnapshot().entries.find((e) => e.path === 'receitas/bolo.md'),
    ).toMatchObject({ title: 'Bolo de fubá' });
  });

  test('sem pasta: aria-disabled com o motivo visível; o clique não muda nada nem grava', async () => {
    const h = await setup({ 'nota.md': '# Nota\n' }, { catalog: true, open: false });
    render(<App app={h.app} />);
    const toggle = openFolderSection(h);
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(toggle.getAttribute('aria-describedby')).toBe(
      'set-index-cloud-novault set-index-cloud-help',
    );
    expect(document.getElementById('set-index-cloud-novault')?.textContent).toBe(
      'Abra uma pasta para escolher como as notas dela são indexadas.',
    );
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(h.app.store.getState().indexCloudOnly).toBe(false);
    expect(screen.getByTestId('settings-live').textContent).toBe('');
    await act(() => vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 2));
    expect(h.writes()).toBe(0);
  });
});

describe('AC-R36-3: #tags do corpo na busca do catálogo', () => {
  test('o extrator real põe #Plantão do corpo no índice; #plantao (sem acento/caixa) e "plant" acham a nota; em código não conta', async () => {
    const h = await setup(
      {
        'ideias.md': '# Ideias\n\nCom #Plantão hoje.\n',
        'outra.md': '# Outra\n\nSó `#plantao` em código.\n',
      },
      { catalog: true },
    );
    await settleIndex(h);
    const entries = h.app.catalog.getSnapshot().entries;
    expect(entries.find((e) => e.path === 'ideias.md')).toMatchObject({
      tags: [],
      inlineTags: ['#Plantão'],
    });
    const keys = buildSearchKeys(entries);
    const found = (query: string) => filterKeys(keys, query).map((key) => key.entry.path);
    expect(found('#plantao')).toEqual(['ideias.md']);
    expect(found('#PLANTÃO')).toEqual(['ideias.md']);
    expect(found('plant')).toEqual(['ideias.md']);
  });
});
