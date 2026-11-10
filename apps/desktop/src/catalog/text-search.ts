import type { Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  CONTENT_SEARCH_FIELD_ID,
  CONTENT_SEARCH_IDLE,
  type ContentSearchState,
} from '@simplemd/ui';
import {
  checkSearchQuery,
  foldForSearch,
  searchNote,
  SEARCH_LIMIT_DEFAULT,
  type ContentVaultProvider,
  type TextSearchHit,
  type VaultHandle,
} from '@simplemd/vault';
import type { AppController } from '../app/controller';
import type { AppStore } from '../state/store';

/** Pausa da digitação antes de buscar (design-r37 §4). */
export const TEXT_SEARCH_DEBOUNCE_MS = 250;
/** Quadros de espera até o Catálogo montar o campo ou o editor mostrar a nota aberta. */
const SHOW_FRAMES = 30;

/** Título do comando da paleta (`app:search-text`, `Mod-Shift-G`). */
export const TEXT_SEARCH_COMMAND = 'Buscar no texto das notas';

export interface TextSearchDeps {
  readonly vault: Pick<ContentVaultProvider, 'searchText'>;
  readonly store: AppStore;
  /** Abre a nota numa aba (ou foca a aba dela); `false` se não abriu. */
  readonly openFile: (path: string) => Promise<boolean>;
  /** O view que mostra a nota `path` (r39a, `EditorAssembly.viewOf`), ou `null`. */
  readonly viewOf: (path: string) => EditorView | null;
}

/**
 * Busca no texto das notas, o modo "Conteúdo" do Catálogo (r37c, design-r37 §4). Guarda o estado
 * mostrado (`useSyncExternalStore`), espera 250 ms depois da última tecla e faz UMA busca por vez
 * (AppSec r37a item 3): uma nova aborta a anterior e só começa depois que ela voltou, com as leituras
 * dela já terminadas (`searchTree`), então teclas seguidas não acumulam leituras. Trocar ou fechar a
 * pasta aborta e limpa (AppSec r37b). Abrir um resultado leva o cursor ao trecho (`locateHit`).
 */
export class TextSearchController {
  readonly #deps: TextSearchDeps;
  readonly #listeners = new Set<() => void>();
  #state: ContentSearchState = CONTENT_SEARCH_IDLE;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** A busca mais recente: em andamento ou esperando a anterior voltar. */
  #active: AbortController | null = null;
  /** Fim da última busca pedida (nunca rejeita): a próxima só começa depois dele. */
  #tail: Promise<void> = Promise.resolve();

  constructor(deps: TextSearchDeps) {
    this.#deps = deps;
    let handle = deps.store.getState().handle;
    deps.store.subscribe((state) => {
      if (state.handle === handle) return;
      handle = state.handle;
      // Outra pasta (ou nenhuma): a busca da anterior para e o modo volta ao início.
      this.#stop();
      this.#publish(CONTENT_SEARCH_IDLE);
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): ContentSearchState => this.#state;

  /** O campo mudou: a busca em andamento para e a nova começa 250 ms depois da última tecla. */
  setQuery(query: string): void {
    if (query === this.#state.query) return;
    this.#stop();
    if (query === '') {
      this.#publish(CONTENT_SEARCH_IDLE);
      return;
    }
    this.#publish({ ...CONTENT_SEARCH_IDLE, query, status: 'pending' });
    this.#timer = setTimeout(() => this.#begin(), TEXT_SEARCH_DEBOUNCE_MS);
  }

  /** Esc no campo ou "Cancelar": para a busca (ou a espera dela); o que já veio fica na lista. */
  cancel(): void {
    const { status } = this.#state;
    if (status !== 'pending' && status !== 'searching') return;
    this.#stop();
    this.#publish({ ...this.#state, status: 'cancelled' });
  }

  /**
   * Abre a nota do trecho (aba nova ou a existente) e, quando ela aparece num editor, seleciona o
   * trecho, rola até o centro e foca o editor.
   */
  async open(path: string, hit: TextSearchHit): Promise<void> {
    const query = this.#state.searched;
    if (!(await this.#deps.openFile(path))) return;
    this.#reveal(path, hit, query, SHOW_FRAMES);
  }

  #reveal(path: string, hit: TextSearchHit, query: string, frames: number): void {
    const view = this.#deps.viewOf(path);
    if (!view) {
      if (frames > 0) requestAnimationFrame(() => this.#reveal(path, hit, query, frames - 1));
      return;
    }
    const { from, to } = locateHit(view.state.doc, hit, query);
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    view.focus();
  }

  #begin(): void {
    this.#timer = undefined;
    const { query } = this.#state;
    const check = checkSearchQuery(query);
    if (check !== 'ok') {
      this.#publish({ ...this.#state, status: check });
      return;
    }
    const { handle } = this.#deps.store.getState();
    // Sem pasta o temporizador já foi desfeito (a troca de pasta zera o estado).
    if (handle === null) return;
    const controller = new AbortController();
    this.#active = controller;
    this.#publish({
      ...this.#state,
      status: 'searching',
      searched: query,
      limit: SEARCH_LIMIT_DEFAULT,
    });
    this.#tail = this.#tail.then(() => this.#search(handle, query, controller.signal));
  }

  async #search(handle: VaultHandle, query: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    try {
      const result = await this.#deps.vault.searchText?.(handle, query, {
        limit: SEARCH_LIMIT_DEFAULT,
        signal,
        onNotes: (notes) => {
          if (signal.aborted) return;
          this.#publish({ ...this.#state, notes: [...this.#state.notes, ...notes] });
        },
        onProgress: (scanned) => {
          if (!signal.aborted) this.#publish({ ...this.#state, scanned });
        },
      });
      if (signal.aborted) return;
      if (result === undefined) this.#publish({ ...this.#state, status: 'unavailable' });
      else if (result.status !== 'done') this.#publish({ ...this.#state, status: result.status });
      else
        this.#publish({
          ...this.#state,
          status: 'done',
          scanned: result.scanned,
          truncated: result.truncated,
          skipped: result.skipped,
        });
    } catch {
      if (!signal.aborted) this.#publish({ ...this.#state, status: 'error' });
    } finally {
      if (this.#active?.signal === signal) this.#active = null;
    }
  }

  #stop(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#active?.abort();
    this.#active = null;
  }

  #publish(state: ContentSearchState): void {
    this.#state = state;
    for (const listener of [...this.#listeners]) listener();
  }
}

const controllers = new WeakMap<AppController, TextSearchController>();

/** A busca no texto da janela: uma por app, criada no primeiro uso. */
export function textSearchOf(app: AppController): TextSearchController {
  let search = controllers.get(app);
  if (!search) {
    search = new TextSearchController({
      vault: app.platform.vault,
      store: app.store,
      openFile: (path) => app.sync.openFile(path),
      viewOf: (path) => app.plugins.editor.viewOf(path),
    });
    controllers.set(app, search);
  }
  return search;
}

/**
 * "Buscar no texto das notas" (`app:search-text`, `Mod-Shift-G`): o painel lateral no Catálogo, no
 * modo Conteúdo, e o foco no campo, com o texto selecionado para digitar por cima.
 */
export function showTextSearch(app: AppController): void {
  app.store.setState({ sidePanelOpen: true, sidePanelTab: 'catalog', catalogMode: 'content' });
  const focus = (frames: number) => {
    const field = document.getElementById(CONTENT_SEARCH_FIELD_ID);
    if (field instanceof HTMLInputElement) {
      field.focus();
      field.select();
    } else if (frames > 0) requestAnimationFrame(() => focus(frames - 1));
  };
  requestAnimationFrame(() => focus(SHOW_FRAMES));
}

/**
 * Onde selecionar o trecho no documento do editor: a posição da busca (linha e coluna/tamanho em
 * UTF-16, no texto do disco) se o texto ali ainda dobra para a consulta; senão (aba com edição não
 * salva, nota mudada) a primeira ocorrência na mesma linha; sem ela, o início da linha. Sempre dentro
 * da linha: `len` pode ser enorme (AppSec r37a item 2).
 */
export function locateHit(
  doc: Text,
  hit: Pick<TextSearchHit, 'line' | 'col' | 'len'>,
  query: string,
): { from: number; to: number } {
  const line = doc.line(Math.min(Math.max(1, hit.line + 1), doc.lines));
  const from = Math.min(line.from + Math.max(0, hit.col), line.to);
  const to = Math.min(from + Math.max(0, hit.len), line.to);
  if (to > from && foldForSearch(doc.sliceString(from, to)) === foldForSearch(query)) {
    return { from, to };
  }
  const found = searchNote(line.text, query)?.hits[0];
  if (!found) return { from: line.from, to: line.from };
  // `searchNote` tira um U+FEFF do começo do texto (o BOM de uma nota); aqui o texto é uma linha.
  const start = line.from + (line.text.startsWith('\uFEFF') ? 1 : 0) + found.col;
  return { from: start, to: Math.min(start + found.len, line.to) };
}
