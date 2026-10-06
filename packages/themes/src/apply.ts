import type { ThemeBase, Tokens } from './schema';

export interface ThemeWindowOptions {
  /** `requestAnimationFrame` injetável (Vitest/jsdom). */
  readonly raf?: (callback: FrameRequestCallback) => number;
  /** `performance.mark` emitido no quadro seguinte (NFR-8/9/10). */
  readonly mark?: string;
}

/**
 * Janela de supressão de transições (DESIGN §10, V-3): toda escrita de token acontece com
 * `data-theme-applying` no alvo, seguida de um flush de estilo, para que nenhuma transição de
 * hover/foco anime a troca. O atributo sai no quadro seguinte, quando os valores já não mudam.
 * `app.css` tem a regra `[data-theme-applying] * { transition: none !important }`.
 */
export function withThemeWindow(
  target: HTMLElement,
  write: () => void,
  options: ThemeWindowOptions = {},
): void {
  const view = target.ownerDocument.defaultView;
  const raf = options.raf ?? ((callback) => (view ?? globalThis).requestAnimationFrame(callback));
  target.setAttribute('data-theme-applying', '');
  write();
  // Força o cálculo dos valores novos enquanto as transições estão desligadas.
  void view?.getComputedStyle(target).color;
  void target.offsetHeight;
  raf(() => {
    target.removeAttribute('data-theme-applying');
    if (options.mark) performance.mark(options.mark);
  });
}

export interface ApplyThemeOptions extends ThemeWindowOptions {
  /** Base do tema: vira `data-theme-base` e `color-scheme` (controles nativos e barras de rolagem). */
  readonly base?: ThemeBase;
}

/**
 * Aplica tokens como propriedades customizadas inline no alvo (R-4.3, arch-frontend §7.1): grava
 * todas as de `tokens` e remove as de `prev` que não existem mais (nenhuma sobra do tema anterior;
 * AC-4.3). Nunca recarrega nem navega. Devolve as chaves gravadas, para a próxima chamada.
 */
export function applyTheme(
  target: HTMLElement,
  tokens: Tokens,
  prev: ReadonlySet<string> = new Set(),
  options: ApplyThemeOptions = {},
): Set<string> {
  const keys = new Set(Object.keys(tokens));
  withThemeWindow(
    target,
    () => {
      for (const key of prev) if (!keys.has(key)) target.style.removeProperty(key);
      for (const key of keys) target.style.setProperty(key, tokens[key] ?? null);
      if (options.base) {
        target.dataset.themeBase = options.base;
        target.style.colorScheme = options.base;
      }
    },
    { mark: 'simplemd:theme-applied', ...options },
  );
  return keys;
}
