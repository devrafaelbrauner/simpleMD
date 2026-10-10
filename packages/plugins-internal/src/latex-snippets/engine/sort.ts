// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/snippets/sort.ts (transformada de Schwartz: prioridade maior primeiro; empate =
// gatilho mais longo primeiro; empate = ordem original, pois `Array.prototype.sort` é estável).
import type { Snippet } from './snippets';

/** Cópia ordenada por prioridade e, no empate, pelo comprimento do gatilho (fonte da regex). */
export function sortSnippets<S extends Snippet>(snippets: readonly S[]): S[] {
  return snippets
    .map((snippet, i) => {
      const length =
        typeof snippet.trigger === 'string' ? snippet.trigger.length : snippet.trigger.source.length;
      return [snippet.priority ?? 0, length, i] as const;
    })
    .sort((a, b) => b[0] - a[0] || b[1] - a[1])
    .map(([, , i]) => snippets[i] as S);
}
