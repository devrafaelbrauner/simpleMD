// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { noteContext } from '@simplemd/core';
import { builtinHotkeys, normalizeHotkey } from '@simplemd/plugin-api/runtime';
import { CONTENT_SEARCH_FIELD_ID, CONTENT_SEARCH_IDLE } from '@simplemd/ui';
import type {
  TextSearchNote,
  TextSearchOptions,
  TextSearchResult,
  VaultHandle,
} from '@simplemd/vault';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/app/App';
import { matchGlobalKey, SEARCH_TEXT_KEY } from '../src/app/global-keys';
import {
  locateHit,
  TEXT_SEARCH_COMMAND,
  TEXT_SEARCH_DEBOUNCE_MS,
  TextSearchController,
  textSearchOf,
} from '../src/catalog/text-search';
import { createAppStore } from '../src/state/store';
import { setup, type Harness } from './helpers';

/**
 * r37c (design-r37 §4; AC-R37-1, AC-R37-3): a busca no texto no app real — `Mod-Shift-G` e o
 * comando abrem o Catálogo no modo Conteúdo com o foco no campo; digitar busca (uma busca por vez,
 * AppSec r37a item 3); Enter abre a nota com o trecho selecionado, também com CRLF, BOM e NFD; a aba
 * com edição procura na linha; trocar de pasta aborta e limpa.
 */
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty('--dimension-explorer-row-height');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const FILES = {
  'receitas/feijoada.md':
    '# Feijoada\n\nA ação começa cedo.\nAÇÃO também conta, e acao sem acento.\n',
  'notas/crlf.md': '# CRLF\r\n\r\nPrimeira linha.\r\nA ação fica na quarta linha.\r\n',
  'notas/bom.md': '\uFEFF# Com BOM\n\nAÇÃO logo na terceira linha.\n',
  'notas/nfd.md': '# Decomposta\n\nAc\u0327a\u0303o em NFD.\n',
  'nuvem.md': '# Nuvem\n\nA ação daqui não é lida.\n',
  'outra.md': '# Outra\n\nNada.\n',
};

/** Ctrl+Shift+G (o jsdom não é macOS): o atalho global roda na captura da janela. */
function pressSearch(target: Element = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'G',
    code: 'KeyG',
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

async function openApp(): Promise<Harness> {
  const h = await setup(FILES);
  h.port.setCloudOnly('nuvem.md');
  render(<App app={h.app} />);
  return h;
}

const field = () => document.getElementById(CONTENT_SEARCH_FIELD_ID) as HTMLInputElement | null;

/** Abre a busca pelo atalho, digita e espera o fim (debounce de 250 ms + a busca na memória). */
async function searchFor(query: string): Promise<HTMLElement> {
  pressSearch();
  await vi.waitFor(() => expect(document.activeElement).toBe(field()));
  fireEvent.change(field()!, { target: { value: query } });
  await vi.waitFor(() => expect(screen.getByTestId('content-search').dataset.status).toBe('done'), {
    timeout: 5000,
  });
  return screen.getByRole('listbox', { name: 'Resultados' });
}

function editorOf(h: Harness): EditorView {
  const view = h.app.plugins.editor.view;
  if (!view) throw new Error('editor não montado');
  return view;
}

/** Espera o editor mostrar `path` com `text` selecionado; devolve a linha (1-based) da seleção. */
async function selected(h: Harness, path: string, text: string): Promise<number> {
  let line = 0;
  await vi.waitFor(
    () => {
      const view = editorOf(h);
      expect(view.state.facet(noteContext).path).toBe(path);
      const { from, to } = view.state.selection.main;
      expect(view.state.sliceDoc(from, to)).toBe(text);
      line = view.state.doc.lineAt(from).number;
    },
    { timeout: 5000 },
  );
  return line;
}

describe('AC-R37-1: acha o termo no corpo e abre a nota no trecho', () => {
  // O jsdom não faz layout nem carrega a folha de tokens: a lista virtualizada mede 240 × 600 e a
  // linha do explorador tem a altura do token (como nos testes do Catálogo).
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(240);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(240);
    document.documentElement.style.setProperty('--dimension-explorer-row-height', '28px');
  });

  test('Ctrl+Shift+G → Conteúdo com foco no campo; "acao" acha acentos, CRLF, BOM e NFD; Enter seleciona', async () => {
    const h = await openApp();
    const list = await searchFor('acao');
    const state = h.app.store.getState();
    expect(state.sidePanelOpen).toBe(true);
    expect(state.sidePanelTab).toBe('catalog');
    expect(state.catalogMode).toBe('content');
    const modes = screen.getByRole('group', { name: 'Buscar em' });
    expect(
      within(modes).getByRole('button', { name: 'Conteúdo' }).getAttribute('aria-pressed'),
    ).toBe('true');
    // Percurso: notas da raiz, depois as pastas, pela ordem do nome.
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'bom — linha 3: AÇÃO logo na terceira linha.',
      'crlf — linha 4: A ação fica na quarta linha.',
      'nfd — linha 3: Ac\u0327a\u0303o em NFD.',
      'feijoada — linha 3: A ação começa cedo.',
      'feijoada — linha 4: AÇÃO também conta, e acao sem acento.',
      'feijoada — linha 4: AÇÃO também conta, e acao sem acento.',
    ]);
    // Nuvem pulada sem ler (D-R37-1), contada no resumo; nenhuma gravação.
    expect(screen.getByTestId('content-search-status').textContent).toBe(
      '6 resultados em 4 notas. 1 nota não lida: 1 só na nuvem.',
    );
    expect(h.port.calls().some((c) => c.op === 'readFile' && c.abs.endsWith('/nuvem.md'))).toBe(
      false,
    );
    expect(h.writes()).toBe(0);

    // ↓ do campo vai à lista; ↓ ao trecho do CRLF; Enter abre com "ação" selecionado na linha 4.
    fireEvent.keyDown(field()!, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('aria-posinset')).toBe('1');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(await selected(h, 'notas/crlf.md', 'ação')).toBe(4);
    expect(document.activeElement).toBe(editorOf(h).contentDOM);

    // BOM: a linha conta sem ele.
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Home' });
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' });
    expect(await selected(h, 'notas/bom.md', 'AÇÃO')).toBe(3);

    // NFD: o trecho inteiro (com as marcas) fica selecionado.
    const nfd = screen.getAllByRole('option').find((o) => o.dataset.path === 'notas/nfd.md');
    fireEvent.click(nfd!);
    expect(await selected(h, 'notas/nfd.md', 'Ac\u0327a\u0303o')).toBe(3);

    // A terceira ocorrência de feijoada: o segundo casamento da linha 4.
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'End' });
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' });
    expect(await selected(h, 'receitas/feijoada.md', 'acao')).toBe(4);
    expect(editorOf(h).state.selection.main.from - editorOf(h).state.doc.line(4).from).toBe(21);
    expect(h.writes()).toBe(0);
  });

  test('aba com edição não salva: procura o termo na linha; sem ele, o início da linha', async () => {
    const h = await openApp();
    // A gravação automática fica presa: o disco segue com o texto antigo durante o teste.
    h.port.fault({ op: 'writeFile', delayMs: 60_000 });
    await act(async () => {
      await h.app.sync.openFile('receitas/feijoada.md');
    });
    const view = editorOf(h);
    await vi.waitFor(() => expect(view.state.facet(noteContext).path).toBe('receitas/feijoada.md'));
    // Linha 3: "A ação…" → "Hoje, A ação…" (a coluna do disco não vale mais); linha 4 sem o termo.
    const line3 = view.state.doc.line(3);
    const line4 = view.state.doc.line(4);
    act(() => {
      view.dispatch({
        changes: [
          { from: line3.from, insert: 'Hoje, ' },
          { from: line4.from, to: line4.to, insert: 'Trocada por outra coisa.' },
        ],
      });
    });
    expect(h.app.store.getState().docs['receitas/feijoada.md']).toBe('dirty');
    const list = await searchFor('acao');
    const feijoada = within(list)
      .getAllByRole('option')
      .filter((o) => o.dataset.path === 'receitas/feijoada.md');
    expect(feijoada.map((o) => o.dataset.line)).toEqual(['3', '4', '4']);

    fireEvent.click(feijoada[0]!);
    expect(await selected(h, 'receitas/feijoada.md', 'ação')).toBe(3);
    expect(view.state.selection.main.from - view.state.doc.line(3).from).toBe(8);

    fireEvent.click(feijoada[1]!);
    await vi.waitFor(() => {
      const { from, to } = view.state.selection.main;
      expect([from, to]).toEqual([view.state.doc.line(4).from, view.state.doc.line(4).from]);
    });
    expect(h.app.store.getState().docs['receitas/feijoada.md']).not.toBe('clean');
  });

  test('comando "Buscar no texto das notas" (Mod-Shift-G) na paleta; reservado; inativo sem pasta e sob modal', async () => {
    const h = await setup(FILES, { open: false });
    render(<App app={h.app} />);
    const command = h.app.plugins.commands.get('app:search-text');
    expect(command?.title).toBe(TEXT_SEARCH_COMMAND);
    expect(command?.hotkey).toBe(SEARCH_TEXT_KEY);
    expect(command?.isEnabled?.()).toEqual({ reason: 'Abra uma pasta primeiro.' });
    // Sem pasta, a tecla não age (e segue adiante).
    expect(pressSearch().defaultPrevented).toBe(false);
    expect(h.app.store.getState().sidePanelOpen).toBe(false);

    await act(async () => {
      await h.app.sync.openVault('welcome');
    });
    expect(command?.isEnabled?.()).toBe(true);
    act(() => h.app.store.setState({ paletteOpen: true }));
    pressSearch();
    expect(h.app.store.getState().sidePanelOpen).toBe(false);
    act(() => h.app.store.setState({ paletteOpen: false }));

    // O comando faz o mesmo que a tecla: Conteúdo, com o foco no campo.
    await act(async () => {
      await command?.run();
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(field()));
    expect(h.app.store.getState().catalogMode).toBe('content');
    // Notas volta ao modo de sempre (o campo dele, a ordenação).
    fireEvent.click(screen.getByRole('button', { name: 'Notas' }));
    expect(h.app.store.getState().catalogMode).toBe('notes');
    expect(screen.getByRole('combobox', { name: 'Ordenar por' })).toBeTruthy();

    const key = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: true };
    expect(matchGlobalKey({ ...key, key: 'G', metaKey: true }, 'mac')).toBe('search-text');
    expect(matchGlobalKey({ ...key, key: 'g', ctrlKey: true }, 'other')).toBe('search-text');
    expect(matchGlobalKey({ ...key, key: 'g', ctrlKey: true, shiftKey: false }, 'other')).toBe(
      null,
    );
    for (const platform of ['mac', 'other'] as const)
      expect(builtinHotkeys([], platform).has(normalizeHotkey('Mod-Shift-g', platform))).toBe(true);
  });

  test('trocar de pasta aborta a busca e limpa o modo Conteúdo', async () => {
    const h = await openApp();
    const search = textSearchOf(h.app);
    expect(textSearchOf(h.app)).toBe(search);
    const provider = vi.spyOn(h.app.platform.vault, 'searchText');
    h.port.fault({ op: 'readFile', delayMs: 200 });
    pressSearch();
    await vi.waitFor(() => expect(document.activeElement).toBe(field()));
    fireEvent.change(field()!, { target: { value: 'acao' } });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(search.getSnapshot().status).toBe('searching');
    const signal = provider.mock.calls[0]?.[2].signal;
    await act(async () => {
      await h.app.sync.openVault('shell');
    });
    expect(signal?.aborted).toBe(true);
    expect(search.getSnapshot()).toBe(CONTENT_SEARCH_IDLE);
    // Nada da pasta anterior chega depois.
    const quiet = Promise.withResolvers<void>();
    setTimeout(quiet.resolve, 600);
    await act(() => quiet.promise);
    expect(search.getSnapshot()).toBe(CONTENT_SEARCH_IDLE);
    expect(provider).toHaveBeenCalledOnce();
    // A pasta nova abre com o painel fechado; o atalho mostra o campo vazio.
    expect(h.app.store.getState().sidePanelOpen).toBe(false);
    pressSearch();
    await vi.waitFor(() => expect(document.activeElement).toBe(field()));
    expect(field()?.value).toBe('');
  });
});

const HANDLE: VaultHandle = { id: 'v1', name: 'v', root: '/vault' };
const NOTE_A: TextSearchNote = { path: 'a.md', total: 1, hits: [] };
const NOTE_B: TextSearchNote = { path: 'b.md', total: 2, hits: [] };
const SKIPPED = { hidden: 0, links: 0, cloud: 0, tooLarge: 0, notUtf8: 0, unreadable: 0 };
const done = (extra: Partial<Extract<TextSearchResult, { status: 'done' }>> = {}) =>
  ({
    status: 'done',
    scanned: 3,
    matched: 1,
    truncated: false,
    cancelled: false,
    skipped: SKIPPED,
    ...extra,
  }) satisfies TextSearchResult;

interface Pending {
  readonly query: string;
  readonly options: TextSearchOptions;
  finish(result: TextSearchResult): void;
  fail(error: unknown): void;
}

/** Porta de busca sob controle do teste: cada chamada fica pendente até `finish`/`fail`. */
function controlled() {
  const pending: Pending[] = [];
  const vault = {
    searchText: vi.fn((_handle: VaultHandle, query: string, options: TextSearchOptions) => {
      const { promise, resolve, reject } = Promise.withResolvers<TextSearchResult>();
      pending.push({ query, options, finish: resolve, fail: reject });
      return promise;
    }),
  };
  const store = createAppStore();
  store.setState({ handle: HANDLE });
  const search = new TextSearchController({
    vault,
    store,
    openFile: async () => true,
    viewOf: () => null,
  });
  return { vault, pending, store, search };
}

describe('TextSearchController: uma busca por vez, cancelar e trocar de pasta', () => {
  test('AppSec r37a item 3: a nova aborta a anterior e só começa depois que ela voltou', async () => {
    vi.useFakeTimers();
    const { vault, pending, search } = controlled();
    search.setQuery('ac');
    expect(search.getSnapshot()).toMatchObject({ query: 'ac', status: 'pending' });
    await vi.advanceTimersByTimeAsync(TEXT_SEARCH_DEBOUNCE_MS - 1);
    search.setQuery('acao');
    await vi.advanceTimersByTimeAsync(TEXT_SEARCH_DEBOUNCE_MS - 1);
    expect(vault.searchText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.map((p) => p.query)).toEqual(['acao']);
    expect(pending[0]?.options.limit).toBe(200);
    expect(search.getSnapshot()).toMatchObject({
      status: 'searching',
      searched: 'acao',
      limit: 200,
    });
    pending[0]?.options.onNotes([NOTE_A]);
    pending[0]?.options.onProgress?.(200);
    expect(search.getSnapshot()).toMatchObject({ notes: [NOTE_A], scanned: 200 });

    search.setQuery('acaos');
    expect(pending[0]?.options.signal?.aborted).toBe(true);
    expect(search.getSnapshot()).toMatchObject({ status: 'pending', notes: [] });
    await vi.advanceTimersByTimeAsync(TEXT_SEARCH_DEBOUNCE_MS);
    // A anterior ainda não voltou: a nova espera; um lote atrasado dela não entra.
    expect(pending).toHaveLength(1);
    expect(search.getSnapshot().status).toBe('searching');
    pending[0]?.options.onNotes([NOTE_B]);
    expect(search.getSnapshot().notes).toEqual([]);
    pending[0]?.finish(done({ cancelled: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.map((p) => p.query)).toEqual(['acao', 'acaos']);
    pending[1]?.options.onNotes([NOTE_B]);
    pending[1]?.finish(done({ truncated: true, scanned: 9 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(search.getSnapshot()).toMatchObject({
      status: 'done',
      notes: [NOTE_B],
      truncated: true,
      scanned: 9,
      skipped: SKIPPED,
    });
  });

  test('cancelar mantém o que veio; na espera, nada é buscado; campo vazio volta ao início', async () => {
    vi.useFakeTimers();
    const { vault, pending, search } = controlled();
    search.setQuery('acao');
    await vi.advanceTimersByTimeAsync(TEXT_SEARCH_DEBOUNCE_MS);
    pending[0]?.options.onNotes([NOTE_A]);
    search.cancel();
    expect(pending[0]?.options.signal?.aborted).toBe(true);
    expect(search.getSnapshot()).toMatchObject({ status: 'cancelled', notes: [NOTE_A] });
    pending[0]?.finish(done({ cancelled: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(search.getSnapshot().status).toBe('cancelled');
    // Cancelar fora de uma busca não muda nada.
    search.cancel();
    expect(search.getSnapshot().status).toBe('cancelled');

    search.setQuery('feijao');
    search.cancel();
    await vi.advanceTimersByTimeAsync(TEXT_SEARCH_DEBOUNCE_MS * 2);
    expect(vault.searchText).toHaveBeenCalledOnce();
    expect(search.getSnapshot()).toMatchObject({ query: 'feijao', status: 'cancelled' });
    search.setQuery('');
    expect(search.getSnapshot()).toBe(CONTENT_SEARCH_IDLE);
  });

  test('curta e longa sem tocar a porta; indisponível; erro; a mesma consulta não recomeça', async () => {
    vi.useFakeTimers();
    const { vault, pending, search } = controlled();
    search.setQuery('á');
    await vi.advanceTimersByTimeAsync(TEXT_SEARCH_DEBOUNCE_MS);
    expect(search.getSnapshot().status).toBe('short');
    search.setQuery('x'.repeat(257));
    await vi.advanceTimersByTimeAsync(TEXT_SEARCH_DEBOUNCE_MS);
    expect(search.getSnapshot().status).toBe('long');
    expect(vault.searchText).not.toHaveBeenCalled();

    search.setQuery('acao');
    await vi.advanceTimersByTimeAsync(TEXT_SEARCH_DEBOUNCE_MS);
    pending[0]?.finish({ status: 'unavailable' });
    await vi.advanceTimersByTimeAsync(0);
    expect(search.getSnapshot().status).toBe('unavailable');
    search.setQuery('acao');
    expect(vault.searchText).toHaveBeenCalledOnce();

    search.setQuery('feijao');
    await vi.advanceTimersByTimeAsync(TEXT_SEARCH_DEBOUNCE_MS);
    pending[1]?.fail(new Error('IO'));
    await vi.advanceTimersByTimeAsync(0);
    expect(search.getSnapshot().status).toBe('error');

    // Porta sem busca: indisponível.
    const store = createAppStore();
    store.setState({ handle: HANDLE });
    const bare = new TextSearchController({
      vault: {},
      store,
      openFile: async () => true,
      viewOf: () => null,
    });
    bare.setQuery('acao');
    await vi.advanceTimersByTimeAsync(TEXT_SEARCH_DEBOUNCE_MS);
    expect(bare.getSnapshot().status).toBe('unavailable');
  });

  test('trocar ou fechar a pasta aborta a busca e a espera, e limpa', async () => {
    vi.useFakeTimers();
    const { vault, pending, store, search } = controlled();
    const listener = vi.fn();
    const off = search.subscribe(listener);
    search.setQuery('acao');
    await vi.advanceTimersByTimeAsync(TEXT_SEARCH_DEBOUNCE_MS);
    pending[0]?.options.onNotes([NOTE_A]);
    store.setState({ handle: { ...HANDLE, id: 'v2' } });
    expect(pending[0]?.options.signal?.aborted).toBe(true);
    expect(search.getSnapshot()).toBe(CONTENT_SEARCH_IDLE);
    pending[0]?.options.onNotes([NOTE_B]);
    pending[0]?.finish(done());
    await vi.advanceTimersByTimeAsync(0);
    expect(search.getSnapshot()).toBe(CONTENT_SEARCH_IDLE);

    search.setQuery('feijao');
    store.setState({ handle: null });
    await vi.advanceTimersByTimeAsync(TEXT_SEARCH_DEBOUNCE_MS);
    expect(vault.searchText).toHaveBeenCalledOnce();
    expect(search.getSnapshot()).toBe(CONTENT_SEARCH_IDLE);
    // Mudanças da store sem troca de pasta não mexem na busca.
    search.setQuery('acao');
    store.setState({ sidePanelOpen: true });
    expect(search.getSnapshot().status).toBe('pending');
    expect(listener).toHaveBeenCalled();
    off();
    listener.mockClear();
    search.setQuery('');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('locateHit: o trecho no documento do editor', () => {
  const doc = (text: string) => EditorState.create({ doc: text }).doc;
  const hit = (line: number, col: number, len: number) => ({ line, col, len });

  test('posição do disco quando o texto ainda casa (marcas incluídas); len enorme fica na linha', () => {
    const d = doc('# T\n\nA ação aqui.\nAc\u0327a\u0303o fim');
    expect(locateHit(d, hit(2, 2, 4), 'acao')).toEqual({ from: 7, to: 11 });
    expect(locateHit(d, hit(3, 0, 6), 'ACAO')).toEqual({ from: 18, to: 24 });
    expect(locateHit(d, hit(2, 2, 1_000_002), 'ação aqui.')).toEqual({ from: 7, to: 17 });
  });

  test('texto mudado: a primeira ocorrência na linha; sem ela, o início; linha além do fim', () => {
    const d = doc('# T\n\nHoje, A ação aqui.\nnada\n\uFEFFação');
    expect(locateHit(d, hit(2, 2, 4), 'acao')).toEqual({ from: 13, to: 17 });
    expect(locateHit(d, hit(3, 0, 4), 'acao')).toEqual({ from: 24, to: 24 });
    // Linha além do fim → a última; um U+FEFF no começo de uma linha do meio conta na coluna.
    expect(locateHit(d, hit(9, 0, 4), 'acao')).toEqual({ from: 30, to: 34 });
  });
});
