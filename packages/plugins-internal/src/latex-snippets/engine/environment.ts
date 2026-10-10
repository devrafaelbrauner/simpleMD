// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/snippets/environment.ts.

/** Um ambiente da fórmula em que a semântica de um snippet muda (ex.: `\pu{…}`). */
export interface Environment {
  readonly openSymbol: string;
  readonly closeSymbol: string;
}

/** Gatilhos (fonte, depois das variáveis) e os ambientes em que NÃO rodam. */
export const EXCLUSIONS: Readonly<Record<string, Environment>> = {
  '([A-Za-z])(\\d)': { openSymbol: '\\pu{', closeSymbol: '}' },
  '->': { openSymbol: '\\ce{', closeSymbol: '}' },
};
