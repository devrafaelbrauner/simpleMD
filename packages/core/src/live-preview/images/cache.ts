import { liveCounters } from '../counters';
import type { ImageError, ImageHandle, ImageSource, ImageState } from './source';

/** Bytes lidos e conferidos pelo provider (`ContentVaultProvider.readImage`). */
export interface ImageBytes {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly mtime: number;
}

export interface ImageBlobCacheOptions {
  /** Leitura pelo provider; a recusa traz `code` (`VaultErrorCode`). */
  read(path: string): Promise<ImageBytes>;
  /** Padrão: `URL.createObjectURL` / `URL.revokeObjectURL` (injetáveis nos testes). */
  createObjectURL?(blob: Blob): string;
  revokeObjectURL?(url: string): void;
  /** Teto de bytes em blobs vivos por janela (R-I1.7: 200 MiB). */
  maxBytes?: number;
}

/** Teto padrão de blobs vivos por janela (R-I1.7, AC-I1.9). */
export const IMAGE_CACHE_MAX_BYTES = 200 * 1024 * 1024;

const LOADING: ImageState = { kind: 'loading' };

/** Código do `VaultError` (ou do erro do Rust) → estado visível (STR-146; F-07 do SN). */
function errorOf(reason: unknown): ImageError {
  const code =
    typeof reason === 'object' && reason !== null && 'code' in reason ? String(reason.code) : '';
  switch (code) {
    case 'OUTSIDE_VAULT':
    case 'INVALID_PATH':
    case 'PERMISSION_DENIED':
      return 'outside';
    case 'UNSUPPORTED_IMAGE':
      return 'bad-type';
    case 'TOO_LARGE':
      return 'too-large';
    default:
      return 'not-found';
  }
}

interface Entry {
  readonly path: string;
  state: ImageState;
  /** URL `blob:` viva desta entrada (só em `ok`). */
  url: string | null;
  bytes: number;
  mtime: number;
  /** Uso mais recente (contador monotônico, LRU). */
  used: number;
  /** Leitura em voo: a resposta só vale se ainda for a mais nova. */
  generation: number;
  loading: boolean;
  readonly listeners: Set<(state: ImageState) => void>;
  readonly owners: Set<string>;
}

/**
 * Cache de imagens da janela (R-I1.7, arch-frontend r7 §5.4; D-R7-S1-03): uma leitura por caminho,
 * uma URL `blob:` por imagem pronta, ≤ `maxBytes` vivos com despejo LRU (primeiro as entradas sem
 * widget na tela, depois as mostradas, que voltam a "carregando" e são pedidas de novo no próximo
 * desenho), `invalidate` na mudança externa, `releaseOwner` ao fechar a aba, `reset` ao trocar de
 * pasta (0 blobs vivos). A URL `blob:` só vai para `<img src>` (SN-SEC-05).
 */
export class ImageBlobCache implements ImageSource {
  readonly #entries = new Map<string, Entry>();
  readonly #read: (path: string) => Promise<ImageBytes>;
  readonly #create: (blob: Blob) => string;
  readonly #revoke: (url: string) => void;
  readonly #maxBytes: number;
  #clock = 0;
  #liveBytes = 0;
  #epoch = 0;

  constructor(options: ImageBlobCacheOptions) {
    this.#read = options.read;
    this.#create = options.createObjectURL ?? ((blob) => URL.createObjectURL(blob));
    this.#revoke = options.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url));
    this.#maxBytes = options.maxBytes ?? IMAGE_CACHE_MAX_BYTES;
  }

  request(path: string, owner: string | null): ImageHandle {
    let entry = this.#entries.get(path);
    if (!entry) {
      entry = {
        path,
        state: LOADING,
        url: null,
        bytes: 0,
        mtime: 0,
        used: 0,
        generation: 0,
        loading: false,
        listeners: new Set(),
        owners: new Set(),
      };
      this.#entries.set(path, entry);
    }
    entry.used = ++this.#clock;
    if (owner !== null) entry.owners.add(owner);
    if (entry.state.kind === 'loading' && !entry.loading) this.#load(entry);
    const current = entry;
    return {
      get state() {
        return current.state;
      },
      subscribe: (listener) => {
        current.listeners.add(listener);
        return () => current.listeners.delete(listener);
      },
    };
  }

  /**
   * Mudança externa (observador/sondagem): relê; removida → "não encontrada" (AC-I1.11). Uma leitura
   * em voo fica velha (a geração nova vence).
   */
  invalidate(path: string): void {
    const entry = this.#entries.get(path);
    if (entry) this.#load(entry);
  }

  /** Aba fechada: entradas sem outro dono e sem widget na tela são descartadas (blob revogado). */
  releaseOwner(owner: string): void {
    for (const entry of [...this.#entries.values()]) {
      entry.owners.delete(owner);
      if (entry.owners.size === 0 && entry.listeners.size === 0) this.#drop(entry);
    }
  }

  /** Troca de pasta: tudo revogado, leituras em voo ignoradas (0 blobs vivos da pasta anterior). */
  reset(): void {
    this.#epoch++;
    for (const entry of [...this.#entries.values()]) this.#drop(entry);
  }

  /** Blobs vivos (`blobs()` do harness; AC-I1.9). */
  stats(): { readonly live: number; readonly bytes: number } {
    let live = 0;
    for (const entry of this.#entries.values()) if (entry.url !== null) live++;
    return { live, bytes: this.#liveBytes };
  }

  #load(entry: Entry): void {
    entry.loading = true;
    const generation = ++entry.generation;
    const epoch = this.#epoch;
    liveCounters.imageLoads++;
    const current = () =>
      epoch === this.#epoch &&
      this.#entries.get(entry.path) === entry &&
      generation === entry.generation;
    this.#read(entry.path).then(
      (image) => {
        if (!current()) return;
        entry.loading = false;
        const previous = entry.url;
        const previousBytes = entry.bytes;
        entry.url = this.#create(new Blob([image.bytes as BlobPart], { type: image.mime }));
        entry.bytes = image.bytes.length;
        entry.mtime = image.mtime;
        this.#liveBytes += entry.bytes - (previous === null ? 0 : previousBytes);
        this.#set(entry, { kind: 'ok', url: entry.url });
        // A URL velha só morre depois de o `<img>` trocar de `src` (troca sem piscar).
        if (previous !== null) this.#revoke(previous);
        this.#evict(entry);
      },
      (reason: unknown) => {
        if (!current()) return;
        entry.loading = false;
        this.#release(entry);
        this.#set(entry, { kind: 'error', error: errorOf(reason) });
      },
    );
  }

  #set(entry: Entry, state: ImageState): void {
    entry.state = state;
    for (const listener of [...entry.listeners]) listener(state);
  }

  /** Revoga o blob da entrada (se houver) e desconta os bytes. */
  #release(entry: Entry): void {
    if (entry.url === null) return;
    this.#revoke(entry.url);
    this.#liveBytes -= entry.bytes;
    entry.url = null;
    entry.bytes = 0;
  }

  #drop(entry: Entry): void {
    entry.generation++;
    this.#release(entry);
    this.#entries.delete(entry.path);
  }

  /** LRU por bytes: primeiro as sem widget, depois as mostradas (nunca a recém-carregada). */
  #evict(keep: Entry): void {
    if (this.#liveBytes <= this.#maxBytes) return;
    const ready = [...this.#entries.values()]
      .filter((entry) => entry.url !== null && entry !== keep)
      .sort(
        (a, b) => Number(a.listeners.size > 0) - Number(b.listeners.size > 0) || a.used - b.used,
      );
    for (const entry of ready) {
      if (this.#liveBytes <= this.#maxBytes) break;
      this.#release(entry);
      if (entry.listeners.size === 0) this.#entries.delete(entry.path);
      else this.#set(entry, LOADING);
    }
  }
}
