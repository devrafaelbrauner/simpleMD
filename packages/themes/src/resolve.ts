import { darkOverrides, lightTokens } from './builtin';
import { fontOption, type FontFamilyName } from './fonts';
import type { ThemeBase, Tokens } from './schema';

/** Preferências de fonte que viram tokens (D-2: ligaduras não são token). */
export interface FontPrefs {
  readonly fontFamily: FontFamilyName;
  readonly fontSize: number;
}

/**
 * Família e tamanho escritos nas mesmas propriedades dos tokens (R-4.4): a pilha vem de
 * `fonts.json` e o tamanho vira `<n>px`.
 */
export function prefTokens(prefs: FontPrefs): Tokens {
  return {
    '--fontFamily-mono': fontOption(prefs.fontFamily).stack,
    '--dimension-font-size': `${prefs.fontSize}px`,
  };
}

/**
 * Tokens finais de um tema (arch-frontend §7.1): claro embutido < substituições do escuro (se a
 * base for escura) < tokens do tema < preferências. A ordem do espalhamento dá a precedência
 * preferência > tema > base (AC-4.13). Sem `prefs`, é o tema puro (prévia do editor de temas).
 */
export function resolveTokens(
  theme: { readonly base: ThemeBase; readonly tokens: Tokens },
  prefs?: FontPrefs,
): Record<string, string> {
  return {
    ...lightTokens,
    ...(theme.base === 'dark' ? darkOverrides : {}),
    ...theme.tokens,
    ...(prefs ? prefTokens(prefs) : {}),
  };
}
