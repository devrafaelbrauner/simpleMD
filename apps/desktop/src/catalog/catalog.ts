import { loadNoteIndexer, type NoteExtractor } from '@simplemd/core';
import {
  createVaultIndex,
  type CatalogClock,
  type CatalogSnapshot,
  type ContentVaultProvider,
  type VaultHandle,
  type VaultIndex,
} from '@simplemd/vault';
import { LinksIndex, type ExplorerSource } from './links';

/** Sem explorador (testes do catálogo): só as entradas do índice. */
const NO_EXPLORER: ExplorerSource = { entries: () => [], subscribe: () => () => {} };
/**
 * Um extrator por janela (parse Lezer com wikilinks, tarefas e tags; r7 S2/S9, arch-backend r7
 * §1.7.5), num pedaço sob demanda carregado na 1ª abertura de pasta (NFR-54, r7 S9a B1).
 */
let extractor: Promise<NoteExtractor> | null = null;

/** Sem pasta aberta: nada listado. */
const IDLE: CatalogSnapshot = { status: 'loading', done: 0, total: 0, entries: [], version: 0 };

/**
 * Catálogo do vault aberto (etapa 9): um `VaultIndex` por pasta, criado na abertura e descartado ao
 * trocar/fechar. A interface lê `subscribe`/`getSnapshot` (`useSyncExternalStore`); a sincronização
 * avisa gravações do app (`saved`, 0 leituras) e mudanças externas (`changed`, só `stat`).
 */
export class CatalogController {
  readonly #provider: ContentVaultProvider;
  readonly #clock: CatalogClock;
  readonly #listeners = new Set<() => void>();
  #index: VaultIndex | null = null;
  #offIndex: (() => void) | null = null;
  /** Abertura à espera do extrator (uma troca ou fecho de pasta antes disso a cancela). */
  #opening: VaultHandle | null = null;
  /** Wikilinks e backlinks sobre este catálogo e a árvore do explorador (r7 S2). */
  readonly links: LinksIndex;

  constructor(
    provider: ContentVaultProvider,
    clock: CatalogClock,
    explorer: ExplorerSource = NO_EXPLORER,
  ) {
    this.#provider = provider;
    this.#clock = clock;
    this.links = new LinksIndex(this, explorer);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): CatalogSnapshot => this.#index?.getSnapshot() ?? IDLE;

  /**
   * Pasta aberta: carrega o extrator e então o índice, que revalida sem bloquear a casca (R-9.7,
   * NFR-27). Até lá o catálogo fica em "carregando" e `saved`/`changed`/`revalidate` não fazem
   * nada: o `start` do índice lista a pasta inteira depois e relê o que mudou (tamanho/mtime).
   */
  open(handle: VaultHandle): void {
    this.close();
    this.#opening = handle;
    extractor ??= loadNoteIndexer().then((indexer) => indexer.createNoteExtractor());
    extractor.then(
      (extract) => {
        if (this.#opening !== handle) return;
        this.#opening = null;
        const index = createVaultIndex({
          provider: this.#provider,
          handle,
          extract,
          clock: this.#clock,
          warn: (message, detail) => console.warn('[simplemd]', message, detail),
        });
        this.#index = index;
        this.#offIndex = index.subscribe(() => this.#emit());
        this.#emit();
        void index.start();
      },
      (error: unknown) => {
        // A próxima abertura tenta de novo (pedaço que não carregou).
        extractor = null;
        if (this.#opening === handle) this.#opening = null;
        console.warn('[simplemd]', 'índice: o extrator não carregou', error);
      },
    );
  }

  /** A pasta saiu (o `flush` já rodou): descarta o índice sem gravar. */
  close(): void {
    this.#opening = null;
    this.#offIndex?.();
    this.#offIndex = null;
    this.#index?.dispose();
    if (this.#index) {
      this.#index = null;
      this.#emit();
    }
  }

  flush(): Promise<void> {
    return this.#index?.flush() ?? Promise.resolve();
  }

  changed(paths: readonly string[]): void {
    void this.#index?.applyChanges(paths);
  }

  /** Sem observador (sondagem): relista o vault e indexa o que é novo ou mudou (CR2-03). */
  revalidate(): void {
    void this.#index?.revalidate();
  }

  saved(path: string, text: string, mtime: number): void {
    this.#index?.applySaved(path, text, mtime);
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
