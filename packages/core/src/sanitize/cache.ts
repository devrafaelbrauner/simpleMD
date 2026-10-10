import { liveCounters } from '../live-preview/counters';

/** Entradas da LRU (arch-frontend r7 §5.2: caches por texto do bloco, 256 entradas). */
export const SANITIZE_CACHE_MAX = 256;

/**
 * Cache do editor por TEXTO do bloco (R-I10.6, NFR-41): o fragmento inerte sanitizado fica
 * guardado e cada desenho recebe um clone (`cloneNode`, sem re-parse — o que foi conferido é o que
 * aparece). Só uma falta roda o sanitizador e soma `sanitizeRuns`; digitar fora dos blocos HTML
 * não chega aqui (o widget só desenha o que mudou), então o contador não anda.
 */
export class SanitizeCache {
  readonly #entries = new Map<string, DocumentFragment>();

  constructor(
    readonly sanitize: (html: string) => DocumentFragment,
    readonly max: number = SANITIZE_CACHE_MAX,
  ) {}

  /** Clone do fragmento sanitizado de `html` (inerte até ser adotado). */
  get(html: string): DocumentFragment {
    let fragment = this.#entries.get(html);
    if (fragment === undefined) {
      liveCounters.sanitizeRuns++;
      fragment = this.sanitize(html);
      if (this.#entries.size >= this.max) {
        const oldest = this.#entries.keys().next();
        if (!oldest.done) this.#entries.delete(oldest.value);
      }
    } else {
      // Recém-usado vai para o fim (ordem de inserção do `Map` = ordem de uso).
      this.#entries.delete(html);
    }
    this.#entries.set(html, fragment);
    return fragment.cloneNode(true) as DocumentFragment;
  }

  get size(): number {
    return this.#entries.size;
  }
}
