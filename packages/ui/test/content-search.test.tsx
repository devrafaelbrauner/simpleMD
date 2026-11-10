import type { TextSearchHit, TextSearchNote } from '@simplemd/vault';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CatalogPanel,
  CONTENT_SEARCH_FIELD_ID,
  CONTENT_SEARCH_IDLE,
  CONTENT_SEARCH_TEXT,
  ContentSearch,
  contentSearchCapped,
  contentSearchCount,
  contentSearchSkipped,
  snippetParts,
  type ContentSearchProps,
  type ContentSearchState,
} from '../src';

/**
 * r37c (design-r37 §4; AC-R37-1, AC-R37-3): o modo "Conteúdo" do Catálogo — trechos só de texto
 * (AppSec r37a item 2, r37b Info), `<mark>` limitado ao trecho, `links` fora das "notas", teclado
 * do campo e da lista virtualizada (≤ 60 montadas, NFR-30) e o grupo "Buscar em".
 */

// O jsdom não faz layout: a lista rolável mede 240 × 600 (como nos testes do Catálogo).
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(240);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(240);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, '__xss');
});

const hit = (line: number, text: string, at: number, len: number): TextSearchHit => ({
  line,
  col: at,
  len,
  text,
  at,
  cutBefore: false,
  cutAfter: false,
});

const HOSTILE_NAME = 'hostil/fatura\u202Etxt.md';
/** Como a lista mostra o nome: o U+202E vira `%E2%80%AE` visível (evidence r37c NB-2). */
const HOSTILE_SHOWN = 'hostil/fatura%E2%80%AEtxt.md';
const BIDI = /[\u202A-\u202E\u2066-\u2069]/u;
const HOSTILE_TEXT = '<img src=x onerror="window.__xss=1"> ação <b>x</b>';
const NOTES: TextSearchNote[] = [
  {
    path: 'receitas/feijoada.md',
    total: 3,
    hits: [
      hit(2, 'A ação começa cedo.', 2, 4),
      hit(3, 'AÇÃO também conta, e acao sem acento.', 0, 4),
      hit(3, 'AÇÃO também conta, e acao sem acento.', 21, 4),
    ],
  },
  { path: HOSTILE_NAME, total: 1, hits: [hit(2, HOSTILE_TEXT, 37, 4)] },
];
const TITLES: Record<string, string> = { 'receitas/feijoada.md': 'Feijoada' };

const done = (extra: Partial<ContentSearchState> = {}): ContentSearchState => ({
  ...CONTENT_SEARCH_IDLE,
  query: 'acao',
  searched: 'acao',
  status: 'done',
  notes: NOTES,
  scanned: 14,
  limit: 200,
  skipped: { hidden: 2, links: 3, cloud: 1, tooLarge: 1, notUtf8: 1, unreadable: 0 },
  ...extra,
});

function search(props: Partial<ContentSearchProps> = {}) {
  const onQueryChange = vi.fn<ContentSearchProps['onQueryChange']>();
  const onCancel = vi.fn<ContentSearchProps['onCancel']>();
  const onRetry = vi.fn<ContentSearchProps['onRetry']>();
  const onOpen = vi.fn<ContentSearchProps['onOpen']>();
  const element = (extra: Partial<ContentSearchProps>) => (
    <ContentSearch
      state={done()}
      titleOf={(path) => TITLES[path] ?? path}
      onQueryChange={onQueryChange}
      onCancel={onCancel}
      onRetry={onRetry}
      onOpen={onOpen}
      rowHeight={28}
      {...props}
      {...extra}
    />
  );
  const view = render(element({}));
  return {
    ...view,
    onQueryChange,
    onCancel,
    onRetry,
    onOpen,
    update: (extra: Partial<ContentSearchProps>) => view.rerender(element(extra)),
  };
}

const field = () => screen.getByRole('searchbox', { name: CONTENT_SEARCH_TEXT.label });
const options = () => screen.queryAllByRole('option');
const status = () => screen.getByTestId('content-search-status').textContent;

describe('trechos só de texto, com o destaque dentro do trecho', () => {
  test('snippetParts: `at + len` além do fim (len 1.000.002) para no fim do trecho', () => {
    const text = 'x'.repeat(40) + 'a\u0301'.repeat(148);
    expect(snippetParts({ text, at: 40, len: 1_000_002 })).toEqual([
      'x'.repeat(40),
      'a\u0301'.repeat(148),
      '',
    ]);
    expect(snippetParts({ text: 'abc', at: 9, len: 2 })).toEqual(['abc', '', '']);
    expect(snippetParts({ text: 'abc', at: -3, len: 1 })).toEqual(['', 'a', 'bc']);
    expect(snippetParts({ text: 'abc', at: Number.NaN, len: Number.NaN })).toEqual(['', '', 'abc']);
  });

  test('o <mark> de um casamento enorme não passa do trecho, e o trecho vem como texto', () => {
    const text = `antes ${'ação '.repeat(60)}`;
    search({
      state: done({ notes: [{ path: 'a.md', total: 1, hits: [hit(0, text, 6, 1_000_002)] }] }),
    });
    const mark = screen.getByRole('option').querySelector('mark');
    expect(mark?.textContent).toBe(text.slice(6));
  });

  test('trecho e nome hostis: nenhum elemento criado, direção isolada em <bdi>', () => {
    const { container } = search();
    const hostile = options().find((o) => o.dataset.path === HOSTILE_NAME);
    expect(hostile?.textContent).toContain('<img src=x onerror="window.__xss=1">');
    expect(container.querySelector('img, b, script')).toBeNull();
    expect('__xss' in window).toBe(false);
    // O nome vem do conteúdo (título só para o leitor de tela + linha + trecho), sem `aria-label`;
    // o caminho (o título, sem índice), o trecho e o cabeçalho ficam cada um num <bdi>.
    expect(hostile?.textContent).toBe(`${HOSTILE_SHOWN} — linha 3: ${HOSTILE_TEXT}`);
    expect(hostile?.hasAttribute('aria-label')).toBe(false);
    expect(hostile?.querySelector('.sr-only > bdi')?.textContent).toBe(HOSTILE_SHOWN);
    expect(hostile?.querySelector('.smd-content-snippet > bdi')?.textContent).toBe(HOSTILE_TEXT);
    const header = screen
      .getAllByTestId('content-note')
      .find((n) => n.dataset.path === HOSTILE_SHOWN);
    expect(header?.querySelector('bdi.smd-content-path')?.textContent).toBe(HOSTILE_SHOWN);
    expect(header?.getAttribute('aria-hidden')).toBe('true');
  });

  test('controles bidi (U+202A–202E, U+2066–2069) visíveis como %HH no nome, caminho, trecho e descrição', () => {
    const path = 'a\u202Ab/c\u2066d\u2069/fatura\u202Etxt.md';
    const text = 'x \u202Bação\u202C \u2067y\u2069 \u202D';
    const { container } = search({
      state: done({ notes: [{ path, total: 1, hits: [hit(0, text, 2, 5)] }] }),
      titleOf: () => 'Fatura\u202Etxt',
    });
    const option = screen.getByRole('option');
    expect(option.textContent).not.toMatch(BIDI);
    expect(container.textContent).not.toMatch(BIDI);
    expect(option.getAttribute('aria-description')).toBe(
      'a%E2%80%AAb/c%E2%81%A6d%E2%81%A9/fatura%E2%80%AEtxt.md',
    );
    expect(option.querySelector('.sr-only > bdi')?.textContent).toBe('Fatura%E2%80%AEtxt');
    expect(option.querySelector('.smd-content-snippet > bdi')?.textContent).toBe(
      'x %E2%80%ABação%E2%80%AC %E2%81%A7y%E2%81%A9 %E2%80%AD',
    );
    // O destaque segue no casamento: a troca vem depois do corte em três partes.
    expect(option.querySelector('mark')?.textContent).toBe('%E2%80%ABação');
    const header = screen.getByTestId('content-note');
    expect(header.querySelector('bdi.smd-content-path')?.textContent).toBe(
      'a%E2%80%AAb/c%E2%81%A6d%E2%81%A9/fatura%E2%80%AEtxt.md',
    );
    // O cabeçalho só exibe: o `data-path` dele segue a forma neutralizada (evidence r41d NB-1).
    expect(header.dataset.path).toBe('a%E2%80%AAb/c%E2%81%A6d%E2%81%A9/fatura%E2%80%AEtxt.md');
    expect(header.outerHTML).not.toMatch(BIDI);
    // O caminho de verdade fica nos dados da opção (abrir a nota usa ele).
    expect(option.dataset.path).toBe(path);
  });
});

describe('resumo e estados (região de status)', () => {
  test('contagens pt-BR; links e ocultos nunca contam como notas não lidas', () => {
    expect(contentSearchCount(NOTES)).toBe('4 resultados em 2 notas');
    expect(contentSearchCount([{ path: 'a.md', total: 1, hits: [] }])).toBe(
      '1 resultado em 1 nota',
    );
    expect(
      contentSearchCount([{ path: 'a.md', total: 1200, hits: [] }, ...NOTES.slice(0, 1)]),
    ).toBe('1.203 resultados em 2 notas');
    const none = { hidden: 9, links: 2000, cloud: 0, tooLarge: 0, notUtf8: 0, unreadable: 0 };
    expect(contentSearchSkipped(none)).toBeNull();
    expect(contentSearchSkipped({ ...none, cloud: 1 })).toBe('1 nota não lida: 1 só na nuvem.');
    expect(
      contentSearchSkipped({ ...none, cloud: 2, tooLarge: 1, notUtf8: 1, unreadable: 2 }),
    ).toBe('6 notas não lidas: 2 só na nuvem, 1 acima de 2 MB, 1 fora do UTF-8, 2 ilegíveis.');
  });

  test('done: resultados, corte e não lidas no status; o visível é o mesmo texto, sem anúncio', () => {
    search({ state: done({ truncated: true }) });
    expect(status()).toBe(
      '4 resultados em 2 notas. A busca parou em 200 notas; refine o termo para ver as outras. ' +
        '3 notas não lidas: 1 só na nuvem, 1 acima de 2 MB, 1 fora do UTF-8.',
    );
    expect(screen.getByTestId('content-search-status').getAttribute('role')).toBe('status');
    const visible = screen.getByTestId('content-search-summary');
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(visible.querySelectorAll('p')).toHaveLength(3);
    expect(screen.queryByTestId('content-search-cancel')).toBeNull();
  });

  test('até 5 trechos por nota: o chip diz "5 de 12" e o status avisa; sem corte, nada muda', () => {
    const many = Array.from({ length: 5 }, (_, n) => hit(n, `ação ${n}`, 0, 4));
    const capped: TextSearchNote = { path: 'muitas.md', total: 12, hits: many };
    expect(contentSearchCapped(NOTES)).toBeNull();
    expect(contentSearchCapped([capped])).toBe('Mostrando até 5 trechos por nota.');
    const { update } = search({ state: done({ notes: [capped, ...NOTES], skipped: null }) });
    expect(status()).toBe('16 resultados em 3 notas. Mostrando até 5 trechos por nota.');
    const chips = screen.getAllByTestId('content-note').map((n) => n.querySelector('.smd-chip'));
    expect(chips.map((chip) => chip?.textContent)).toEqual(['5 de 12', '3', '1']);
    expect(options()).toHaveLength(9);
    update({ state: done({ status: 'cancelled', notes: [capped], skipped: null }) });
    expect(status()).toBe(
      'Busca cancelada: 12 resultados em 1 nota. Mostrando até 5 trechos por nota.',
    );
  });

  test('nenhum resultado, curto, longo, cancelado, indisponível, erro e o início', () => {
    const { update } = search({ state: done({ notes: [], searched: 'x\u202Ey' }) });
    expect(status()).toBe(
      'Nenhuma nota contém “x\u202Ey”. 3 notas não lidas: 1 só na nuvem, 1 acima de 2 MB, 1 fora do UTF-8.',
    );
    expect(screen.getByTestId('content-search-summary').querySelector('bdi')?.textContent).toBe(
      'x\u202Ey',
    );
    expect(screen.queryByRole('listbox')).toBeNull();
    update({ state: done({ status: 'short', notes: [], skipped: null }) });
    expect(status()).toBe(CONTENT_SEARCH_TEXT.short);
    update({ state: done({ status: 'long', notes: [], skipped: null }) });
    expect(status()).toBe(CONTENT_SEARCH_TEXT.long);
    update({ state: done({ status: 'cancelled', skipped: null }) });
    expect(status()).toBe('Busca cancelada: 4 resultados em 2 notas.');
    expect(options()).toHaveLength(4);
    update({ state: done({ status: 'cancelled', notes: [], skipped: null }) });
    expect(status()).toBe('Busca cancelada.');
    update({ state: done({ status: 'unavailable', notes: [] }) });
    expect(status()).toBe(CONTENT_SEARCH_TEXT.unavailable);
    update({ state: done({ status: 'error', notes: [] }) });
    expect(status()).toBe(CONTENT_SEARCH_TEXT.error);
    update({ state: CONTENT_SEARCH_IDLE });
    expect(status()).toBe('');
    expect(screen.getByText(CONTENT_SEARCH_TEXT.idle)).toBeTruthy();
  });

  test('buscando: progresso sem anúncio, "Cancelar" e os lotes que já chegaram', () => {
    const { update, onCancel } = search({
      state: done({ status: 'searching', scanned: 0, notes: [], skipped: null }),
    });
    const progress = screen.getByTestId('content-search-progress');
    expect(progress.getAttribute('aria-live')).toBe('off');
    expect(progress.textContent).toBe('Buscando…');
    expect(status()).toBe('');
    update({ state: done({ status: 'searching', scanned: 1200, skipped: null }) });
    expect(screen.getByTestId('content-search-progress').textContent).toBe('Buscando… 1.200 notas');
    expect(options()).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: CONTENT_SEARCH_TEXT.cancel }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(field());
    // Esperando a pausa da digitação também cancela; sem progresso ainda.
    update({ state: done({ status: 'pending', notes: [], skipped: null }) });
    expect(screen.queryByTestId('content-search-progress')).toBeNull();
    expect(screen.getByRole('button', { name: CONTENT_SEARCH_TEXT.cancel })).toBeTruthy();
  });

  test('"Cancelar" com o foco some no fim da busca: o foco volta ao campo', () => {
    const { update } = search({ state: done({ status: 'searching', skipped: null }) });
    screen.getByRole('button', { name: CONTENT_SEARCH_TEXT.cancel }).focus();
    update({ state: done() });
    expect(screen.queryByRole('button', { name: CONTENT_SEARCH_TEXT.cancel })).toBeNull();
    expect(document.activeElement).toBe(field());
  });
});

describe('teclado (AC-R37-3): campo ↔ lista, ↑/↓/Home/End/PageUp/PageDown, Enter e Esc', () => {
  test('nome de cada trecho = "título — linha N: trecho"; caminho na descrição', () => {
    search();
    const list = screen.getByRole('listbox', { name: CONTENT_SEARCH_TEXT.listbox });
    const first = within(list).getAllByRole('option')[0];
    expect(first?.getAttribute('aria-selected')).toBe('true');
    expect(first?.getAttribute('aria-setsize')).toBe('4');
    expect(first?.getAttribute('aria-posinset')).toBe('1');
    expect(first?.getAttribute('aria-description')).toBe('receitas/feijoada.md');
    // Nome pelo conteúdo (WCAG 2.5.3: todo o texto visível está nele, na ordem do DOM).
    expect(first?.textContent).toBe('Feijoada — linha 3: A ação começa cedo.');
    expect(first?.hasAttribute('aria-label')).toBe(false);
    expect(first?.querySelector('mark')?.textContent).toBe('ação');
    expect(options().filter((o) => o.tabIndex === 0)).toHaveLength(1);
    // Cabeçalho visual da nota: título, caminho e contagem, fora da árvore de acessibilidade.
    const header = screen.getAllByTestId('content-note')[0];
    expect(header?.textContent).toBe('Feijoadareceitas/feijoada.md3');
  });

  test('↓ do campo vai à lista; navegação; Enter abre o trecho; Esc na lista volta ao campo', () => {
    const { onOpen } = search();
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options()[0]);
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('aria-posinset')).toBe('2');
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(list, { key: 'End' });
    expect(document.activeElement?.getAttribute('data-path')).toBe(HOSTILE_NAME);
    fireEvent.keyDown(list, { key: 'PageUp' });
    expect(document.activeElement?.getAttribute('aria-posinset')).toBe('1');
    fireEvent.keyDown(list, { key: 'PageDown' });
    expect(document.activeElement?.getAttribute('aria-posinset')).toBe('4');
    fireEvent.keyDown(list, { key: 'Home' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('receitas/feijoada.md', NOTES[0]?.hits[2]);
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(document.activeElement).toBe(field());
    // Clique também abre.
    fireEvent.click(options()[3]!);
    expect(onOpen).toHaveBeenLastCalledWith(HOSTILE_NAME, NOTES[1]?.hits[0]);
  });

  test('Esc no campo: cancela a busca em andamento; sem busca, limpa; vazio, segue adiante', () => {
    const { update, onCancel, onQueryChange } = search({
      state: done({ status: 'searching', skipped: null }),
    });
    const escape = () => {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      field().dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(escape()).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onQueryChange).not.toHaveBeenCalled();
    update({ state: done() });
    expect(escape()).toBe(true);
    expect(onQueryChange).toHaveBeenCalledWith('');
    update({ state: CONTENT_SEARCH_IDLE });
    expect(escape()).toBe(false);
    fireEvent.change(field(), { target: { value: 'feijão' } });
    expect(onQueryChange).toHaveBeenLastCalledWith('feijão');
    expect(field().id).toBe(CONTENT_SEARCH_FIELD_ID);
  });

  test('lista esvaziada com o foco nela: o foco volta ao campo', () => {
    const { update } = search();
    options()[1]?.focus();
    update({ state: done({ status: 'pending', notes: [], skipped: null }) });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(field());
  });

  test('NFR-30: 500 notas × 5 trechos, ≤ 60 linhas montadas; End monta a última', () => {
    const many: TextSearchNote[] = Array.from({ length: 500 }, (_, n) => ({
      path: `pasta/nota-${n}.md`,
      total: 9,
      hits: Array.from({ length: 5 }, (_, h) => hit(h, `linha com ação ${h}`, 10, 4)),
    }));
    search({ state: done({ notes: many, truncated: true }) });
    const mounted = () => screen.getByRole('listbox').querySelectorAll('[style]').length;
    expect(options()[0]?.getAttribute('aria-setsize')).toBe('2500');
    expect(mounted()).toBeGreaterThan(0);
    expect(mounted()).toBeLessThanOrEqual(60);
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'End' });
    expect(document.activeElement?.getAttribute('aria-posinset')).toBe('2500');
    expect(mounted()).toBeLessThanOrEqual(60);
  });

  test('R37C-UX: subindo (Home, PageUp), o cabeçalho da nota aparece junto com o trecho', () => {
    // 50 notas × 5 trechos: cada nota ocupa 28 (cabeçalho) + 5 × 56 = 308 px; a lista, 600 px.
    const many: TextSearchNote[] = Array.from({ length: 50 }, (_, n) => ({
      path: `pasta/nota-${n}.md`,
      total: 5,
      hits: Array.from({ length: 5 }, (_, h) => hit(h, `linha com ação ${h}`, 10, 4)),
    }));
    // O jsdom não rola: `scrollTo` guarda a posição pedida e `scrollTop` a devolve; a altura
    // rolável é a da lista inteira (o teto que o virtualizador respeita).
    let top = 0;
    const scrolls: number[] = [];
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(() => top);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(50 * 308);
    HTMLElement.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
      top = typeof options === 'object' ? (options.top ?? top) : top;
      scrolls.push(top);
    } as typeof HTMLElement.prototype.scrollTo;
    try {
      search({ state: done({ notes: many }) });
      fireEvent.keyDown(field(), { key: 'ArrowDown' });
      const list = screen.getByRole('listbox');
      fireEvent.keyDown(list, { key: 'End' });
      expect(top).toBe(50 * 308 - 600);
      // PageUp sobe 9 trechos por vez (600 / 56 − 1): 250 → 241 → 232, o 2º trecho da nota 46.
      fireEvent.keyDown(list, { key: 'PageUp' });
      fireEvent.keyDown(list, { key: 'PageUp' });
      expect(document.activeElement?.getAttribute('aria-posinset')).toBe('232');
      expect(document.activeElement?.getAttribute('data-path')).toBe('pasta/nota-46.md');
      expect(scrolls.at(-1)).toBe(46 * 308);
      // Home: o cabeçalho da 1ª nota (0), não o 1º trecho (28).
      fireEvent.keyDown(list, { key: 'Home' });
      expect(document.activeElement?.getAttribute('aria-posinset')).toBe('1');
      expect(scrolls.at(-1)).toBe(0);
      // Descendo, como antes: ↓ até o 5º trecho da nota 1 (560–616 px, passa da área) o alinha
      // embaixo (616 − 600 = 16), sem subir ao cabeçalho.
      for (let i = 0; i < 9; i++) fireEvent.keyDown(list, { key: 'ArrowDown' });
      expect(document.activeElement?.getAttribute('aria-posinset')).toBe('10');
      expect(scrolls.at(-1)).toBe(16);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
    }
  });

  test('R37C-UX: Enter no campo refaz a busca cancelada ou com erro; nos outros estados, não', () => {
    const { update, onRetry } = search({ state: done({ status: 'cancelled', skipped: null }) });
    const enter = () => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      field().dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(enter()).toBe(true);
    expect(onRetry).toHaveBeenCalledOnce();
    update({ state: done({ status: 'error', skipped: null }) });
    expect(enter()).toBe(true);
    expect(onRetry).toHaveBeenCalledTimes(2);
    for (const status of ['done', 'searching', 'pending', 'short', 'unavailable'] as const) {
      update({ state: done({ status, skipped: null }) });
      expect(enter()).toBe(false);
    }
    update({ state: CONTENT_SEARCH_IDLE });
    expect(enter()).toBe(false);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
});

describe('Catálogo: "Buscar em" Notas | Conteúdo', () => {
  const snapshot = {
    status: 'ready' as const,
    done: 0,
    total: 0,
    entries: [],
    version: 1,
  };

  test('dois botões aria-pressed no grupo; Conteúdo troca o corpo e a ordenação some', () => {
    const onModeChange = vi.fn();
    const { rerender } = render(
      <CatalogPanel
        snapshot={snapshot}
        activePath={null}
        onOpen={() => {}}
        rowHeight={56}
        mode="notes"
        onModeChange={onModeChange}
        content={<p data-testid="content-slot">conteúdo</p>}
      />,
    );
    const group = screen.getByRole('group', { name: 'Buscar em' });
    const notes = within(group).getByRole('button', { name: 'Notas' });
    const content = within(group).getByRole('button', { name: 'Conteúdo' });
    expect(notes.getAttribute('aria-pressed')).toBe('true');
    expect(content.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('combobox', { name: 'Ordenar por' })).toBeTruthy();
    expect(screen.queryByTestId('content-slot')).toBeNull();
    fireEvent.click(content);
    expect(onModeChange).toHaveBeenCalledWith('content');
    content.focus();
    rerender(
      <CatalogPanel
        snapshot={snapshot}
        activePath={null}
        onOpen={() => {}}
        rowHeight={56}
        mode="content"
        onModeChange={onModeChange}
        content={<p data-testid="content-slot">conteúdo</p>}
      />,
    );
    expect(screen.getByTestId('content-slot')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Ordenar por' })).toBeNull();
    expect(screen.queryByRole('searchbox', { name: 'Buscar no catálogo' })).toBeNull();
    // O mesmo botão continua no DOM, com o foco, agora apertado.
    expect(document.activeElement).toBe(content);
    expect(content.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('catalog').dataset.mode).toBe('content');
  });

  test('sem onModeChange: só o modo Notas, sem o grupo (como antes)', () => {
    render(
      <CatalogPanel
        snapshot={snapshot}
        activePath={null}
        onOpen={() => {}}
        rowHeight={56}
        mode="content"
        content={<p data-testid="content-slot">conteúdo</p>}
      />,
    );
    expect(screen.queryByRole('group', { name: 'Buscar em' })).toBeNull();
    expect(screen.queryByTestId('content-slot')).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Buscar no catálogo' })).toBeTruthy();
  });
});
