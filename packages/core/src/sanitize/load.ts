import type { HtmlSanitizer } from './sanitizer';

/**
 * Sanitizador do HTML cru sob demanda (NFR-54; r7 bundle): o DOMPurify e a política (`sanitizer.ts`)
 * ficam num pedaço próprio, fora da entrada. Ele chega no primeiro bloco HTML cru que o editor vê
 * ({@link requestHtmlSanitizer}) ou na primeira exportação ({@link loadHtmlSanitizer}, que a
 * exportação espera antes de renderizar). Este é o ÚNICO `import()` de `./sanitizer` (regra do
 * ESLint); o resto do núcleo só importa tipos. Uma instância por janela, a mesma no editor e na
 * exportação (a política é uma só, R-I10.4).
 */
let loaded: HtmlSanitizer | null = null;
let loading: Promise<HtmlSanitizer> | null = null;
/** A última carga falhou: o editor não tenta de novo a cada passada; a exportação tenta. */
let failed = false;

/** O sanitizador já carregado (síncrono), ou `null` enquanto o pedaço não chegou. */
export function loadedHtmlSanitizer(): HtmlSanitizer | null {
  return loaded;
}

/** Carrega o pedaço uma vez; falha → a próxima chamada explícita (exportação) tenta de novo. */
export function loadHtmlSanitizer(): Promise<HtmlSanitizer> {
  loading ??= import('./sanitizer').then(
    (mod) => {
      loaded = mod.createHtmlSanitizer(window);
      failed = false;
      return loaded;
    },
    (error: unknown) => {
      loading = null;
      failed = true;
      throw error;
    },
  );
  return loading;
}

/**
 * Pedido do editor (sem esperar): um bloco HTML cru apareceu e o sanitizador ainda não chegou. A
 * fonte fica como texto até o {@link htmlSanitizerPending} resolver e o editor redesenhar. Falha →
 * um aviso no console e nenhum pedido novo do editor (a fonte continua como texto).
 */
export function requestHtmlSanitizer(): void {
  if (loaded || loading || failed) return;
  loadHtmlSanitizer().catch((error: unknown) =>
    console.warn('[simplemd] o sanitizador do HTML não carregou', error),
  );
}

/** Carga em curso pedida pelo editor (`null` se não há pedido pendente). */
export function htmlSanitizerPending(): Promise<HtmlSanitizer> | null {
  return loaded ? null : loading;
}
