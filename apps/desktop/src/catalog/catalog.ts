import { extractNoteMeta } from '@simplemd/core';
import {
  createVaultIndex,
  type CatalogClock,
  type CatalogSnapshot,
  type ContentVaultProvider,
  type VaultHandle,
  type VaultIndex,
} from '@simplemd/vault';

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

  constructor(provider: ContentVaultProvider, clock: CatalogClock) {
    this.#provider = provider;
    this.#clock = clock;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): CatalogSnapshot => this.#index?.getSnapshot() ?? IDLE;

  /** Pasta aberta: carrega e revalida o índice sem bloquear a casca (R-9.7, NFR-27). */
  open(handle: VaultHandle): void {
    this.close();
    const index = createVaultIndex({
      provider: this.#provider,
      handle,
      extract: extractNoteMeta,
      clock: this.#clock,
      warn: (message, detail) => console.warn('[simplemd]', message, detail),
    });
    this.#index = index;
    this.#offIndex = index.subscribe(() => this.#emit());
    this.#emit();
    void index.start();
  }

  /** A pasta saiu (o `flush` já rodou): descarta o índice sem gravar. */
  close(): void {
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
