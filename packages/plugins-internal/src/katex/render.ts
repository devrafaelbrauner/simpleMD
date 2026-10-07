import type katexLibrary from 'katex';
import type { KatexOptions } from 'katex';

/** Mesmas regras do editor para a exportação (arch-frontend r2 §10.2: entrada `./katex/render`). */
export { displayMathAt, inlineMathInText } from '../shared/scan';

type Katex = typeof katexLibrary;

/** Contagem de renderizações (espião do NFR-21: 0 renderizações por edições fora da fórmula). */
export const katexRenderCounts = { katex: 0 };

export interface MathRender {
  /** HTML do KaTeX (`htmlAndMathml`), gerado pela biblioteca a partir do TeX do documento. */
  readonly html: string;
  /** Mensagem do KaTeX quando o TeX é inválido (`throwOnError: false` → `.katex-error`). */
  readonly error: string | null;
}

let katex: Katex | null = null;
let loading: Promise<Katex> | null = null;

/**
 * Carrega o KaTeX e o CSS dele (com as fontes, arquivos da mesma origem; AC-7.6) na primeira vez
 * que uma fórmula fica visível (R-7.3, arch-frontend r2 §14.2).
 */
export function loadKatex(): Promise<Katex> {
  loading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(
    ([module]) => (katex = module.default),
  );
  return loading;
}

/** Já houve pedido da biblioteca? (documento sem fórmula visível → nunca; arch-frontend r2 §14.2.) */
export function katexRequested(): boolean {
  return loading !== null;
}

/** A biblioteca, se já carregada (o caminho de decoração nunca espera). */
export function loadedKatex(): Katex | null {
  return katex;
}

const OPTIONS: KatexOptions = { throwOnError: false, trust: false, output: 'htmlAndMathml' };
/** LRU por `modo + TeX` (arch-frontend r2 §7.3). */
const CACHE_MAX = 500;
const cache = new Map<string, MathRender>();

/** Só o cache: o campo de blocos nunca renderiza durante uma transação (arch-frontend r2 §7.2). */
export function cachedMath(tex: string, displayMode: boolean): MathRender | undefined {
  return cache.get(`${displayMode ? 'd' : 'i'}${tex}`);
}

/** Renderiza (ou devolve do cache) uma fórmula; exige a biblioteca carregada. */
export function renderMath(lib: Katex, tex: string, displayMode: boolean): MathRender {
  const key = `${displayMode ? 'd' : 'i'}${tex}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  katexRenderCounts.katex++;
  const html = lib.renderToString(tex, { ...OPTIONS, displayMode });
  const result: MathRender = {
    html,
    error: html.includes('katex-error') ? errorMessage(html) : null,
  };
  cache.set(key, result);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return result;
}

/** Mensagem do `title` de `.katex-error` (o KaTeX já a escapa como atributo). */
function errorMessage(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const title = template.content.querySelector('.katex-error')?.getAttribute('title') ?? '';
  return title.replace(/^KaTeX parse error:\s*/, '') || 'erro de sintaxe';
}
