// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createMarkdownExtensions, noteContext } from '@simplemd/core';
import type { CatalogSnapshot } from '@simplemd/vault';
import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/App';
import { LINKS_CONTEXT_SOURCES, useLinksPanel } from '../src/app/useLinksPanel';
import { FX_R7_BOLO_SOURCES, fxR7 } from '../harness/fixtures/r7';
import { setup, type Harness } from './helpers';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

async function harness(files = fxR7()): Promise<Harness> {
  const h = await setup(files, { catalog: true });
  await vi.waitFor(() => expect(h.app.catalog.getSnapshot().status).toBe('ready'), {
    timeout: 10_000,
  });
  return h;
}

/** O hook como o `Shell` o usa: catálogo pelo `useSyncExternalStore`, nota ativa e visibilidade. */
function usePanel(
  h: Harness,
  path: string | null,
  visible: boolean,
  view: () => EditorView | null,
) {
  const catalog = useSyncExternalStore(h.app.catalog.subscribe, h.app.catalog.getSnapshot);
  return useLinksPanel(h.app, catalog, path, visible, view);
}

describe('useLinksPanel — estados, contexto e abrir na linha (R-I2.7)', () => {
  it('sem nota → no-tab; invisível → nada calculado', async () => {
    const h = await harness();
    const { result, rerender } = renderHook(
      ({ path, visible }) => usePanel(h, path, visible, () => null),
      { initialProps: { path: null as string | null, visible: true } },
    );
    expect(result.current.status).toBe('no-tab');
    rerender({ path: 'receitas/Bolo.md', visible: false });
    expect(result.current.groups).toEqual([]);
  });

  it('Bolo: grupos = FX_R7_BOLO_SOURCES; contexto ≤ 200 lido das origens; a aba aberta vale', async () => {
    const h = await harness();
    await h.app.sync.openFile('diario/2026-10-01.md');
    h.type('diario/2026-10-01.md', '');
    const { result } = renderHook(() => usePanel(h, 'receitas/Bolo.md', true, () => null));
    expect(result.current.status).toBe('ready');
    expect(result.current.groups.map((g) => g.path).sort()).toEqual([...FX_R7_BOLO_SOURCES].sort());
    await vi.waitFor(() =>
      expect(
        result.current.groups.every((g) => g.occurrences.every((o) => o.context !== null)),
      ).toBe(true),
    );
    const diario = result.current.groups.find((g) => g.path === 'diario/2026-10-01.md');
    expect(diario?.occurrences).toEqual([
      { line: 6, context: 'Fiz o [[Bolo]] para o café.', matchFrom: 6, matchTo: 14 },
    ]);
    const relativo = result.current.groups.find((g) => g.path === 'notas/relativo.md');
    const first = relativo?.occurrences[0];
    expect(first?.context?.slice(first.matchFrom, first.matchTo)).toBe(
      '[receita do bolo](../receitas/Bolo.md)',
    );
    expect(
      result.current.groups.every((g) =>
        g.occurrences.every((o) => (o.context?.length ?? 0) <= 200),
      ),
    ).toBe(true);
    expect(result.current.overLimit).toBe(false);
    expect(LINKS_CONTEXT_SOURCES).toBe(50);
  });

  it('nota sem backlinks → empty; catálogo indexando → indexing; listagem falhou → error + retry', async () => {
    const h = await harness();
    const { result } = renderHook(() => usePanel(h, 'tabelas.md', true, () => null));
    expect(result.current.status).toBe('empty');
    const ready = h.app.catalog.getSnapshot();
    const revalidate = vi.spyOn(h.app.catalog, 'revalidate');
    const states = renderHook(
      ({ catalog }: { catalog: CatalogSnapshot }) =>
        useLinksPanel(h.app, catalog, 'tabelas.md', true, () => null),
      { initialProps: { catalog: { ...ready, status: 'loading' } as CatalogSnapshot } },
    );
    expect(states.result.current.status).toBe('indexing');
    states.rerender({ catalog: { ...ready, listFailed: true } });
    expect(states.result.current.status).toBe('error');
    states.result.current.onRetry();
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it('CR-S2-07: aba da origem com edição não salva → contexto do disco (as posições são do índice)', async () => {
    const h = await harness();
    await h.app.sync.openFile('diario/2026-10-01.md');
    const record = h.app.registry.get('diario/2026-10-01.md')!;
    const { state } = record.state.update({ changes: { from: 0, insert: 'XXXXXXXX\n' } });
    h.app.sync.onEditorChange('diario/2026-10-01.md', state);
    expect(h.app.store.getState().docs['diario/2026-10-01.md']).toBe('dirty');
    const { result } = renderHook(() => usePanel(h, 'receitas/Bolo.md', true, () => null));
    await vi.waitFor(() =>
      expect(
        result.current.groups.find((g) => g.path === 'diario/2026-10-01.md')?.occurrences,
      ).toEqual([{ line: 6, context: 'Fiz o [[Bolo]] para o café.', matchFrom: 6, matchTo: 14 }]),
    );
  });

  it('CR-S2-07: trocar de pasta esvazia o cache de linhas (mesmo caminho e mtime)', async () => {
    const h = await harness();
    const { result, rerender } = renderHook(() =>
      usePanel(h, 'receitas/Bolo.md', true, () => null),
    );
    await vi.waitFor(() =>
      expect(
        result.current.groups.find((g) => g.path === 'diario/2026-10-01.md')?.occurrences[0]
          ?.context,
      ).toBe('Fiz o [[Bolo]] para o café.'),
    );
    h.port.resetCalls();
    await act(async () => {
      await h.app.sync.openVault('shell');
    });
    await vi.waitFor(() => expect(h.app.catalog.getSnapshot().status).toBe('ready'), {
      timeout: 10_000,
    });
    rerender();
    await vi.waitFor(() =>
      expect(
        h.port.calls().some((c) => c.op === 'readFile' && c.abs.endsWith('/diario/2026-10-01.md')),
      ).toBe(true),
    );
  });

  it('origem ilegível: a ocorrência fica só com a linha (contexto vazio)', async () => {
    const h = await harness();
    h.port.fault({ op: 'readFile', error: 'IO', path: 'notas/sub/profunda.md' });
    const { result } = renderHook(() => usePanel(h, 'receitas/Bolo.md', true, () => null));
    await vi.waitFor(() => {
      const group = result.current.groups.find((g) => g.path === 'wikilinks.md');
      expect(group?.occurrences[0]?.context).not.toBeNull();
    });
    const deep = result.current.groups.find((g) => g.path === 'notas/sub/profunda.md');
    expect(deep?.occurrences.map((o) => o.context)).toEqual([null]);
  });

  it('onOpen abre a origem e põe o cursor na linha da ocorrência', async () => {
    const h = await harness();
    const parent = document.body.appendChild(document.createElement('div'));
    const view = new EditorView({ parent, state: EditorState.create({ doc: '' }) });
    const { result } = renderHook(() => usePanel(h, 'receitas/Bolo.md', true, () => view));
    act(() => result.current.onOpen('diario/2026-10-01.md', 6));
    await vi.waitFor(() => {
      expect(h.app.store.getState().activeId).toBe('diario/2026-10-01.md');
      expect(h.app.store.getState().docs['diario/2026-10-01.md']).toBe('clean');
    });
    view.setState(
      EditorState.create({
        doc: h.text('diario/2026-10-01.md') ?? '',
        extensions: [createMarkdownExtensions(), noteContext.of({ path: 'diario/2026-10-01.md' })],
      }),
    );
    await vi.waitFor(() =>
      expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe(
        'Fiz o [[Bolo]] para o café.',
      ),
    );
    view.destroy();
  });

  it('nota com 1.001 links: o índice guarda 1.000 e o painel avisa (LNK-LIMIT)', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => `[[Bolo]] ${i}`).join('\n');
    const h = await harness({ ...fxR7(), 'muitos.md': `# Muitos\n\n${many}\n` });
    const { result } = renderHook(() => usePanel(h, 'muitos.md', true, () => null));
    expect(result.current.overLimit).toBe(true);
    const entry = h.app.catalog.getSnapshot().entries.find((e) => e.path === 'muitos.md');
    expect(entry?.links).toHaveLength(1000);
    expect(entry?.truncated).toContain('links');
  });
});

describe('App — aba "Links" entre Propriedades e Chat IA', () => {
  it('o painel lateral mostra as 5 abas do app e o painel Links do Bolo', async () => {
    const h = await harness();
    render(<App app={h.app} />);
    await act(async () => {
      await h.app.sync.openFile('receitas/Bolo.md');
    });
    act(() => h.app.store.setState({ sidePanelOpen: true, sidePanelTab: 'links' }));
    const tablist = await screen.findByRole('tablist', { name: 'Painéis' });
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Catálogo', 'Sumário', 'Propriedades', 'Links', 'Chat IA']);
    const region = screen.getByRole('region', { name: 'Links' });
    await vi.waitFor(() =>
      expect(within(region).getByTestId('links-summary').textContent).toBe(
        '5 notas apontam para esta · 14 links',
      ),
    );
    expect(
      within(region)
        .getAllByRole('group')
        .map((g) => g.getAttribute('data-path'))
        .sort(),
    ).toEqual([...FX_R7_BOLO_SOURCES].sort());
  });
});
