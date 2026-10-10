// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/utils/editor_utils.ts (`findMatchingBracket`, `getOpenBracket`, `getCloseBracket`;
// sem o `import { Platform } from 'obsidian'` do resto do arquivo).

const reverse = (s: string) => [...s].reverse().join('');

/**
 * Índice do fechamento que casa com a abertura em `start` (ou, para trás, da abertura que casa com
 * o fechamento em `start`); `-1` se não houver antes de `end`.
 */
export function findMatchingBracket(
  text: string,
  start: number,
  openBracket: string,
  closeBracket: string,
  searchBackwards: boolean,
  end?: number,
): number {
  if (searchBackwards) {
    const reversedIndex = findMatchingBracket(
      reverse(text),
      text.length - (start + closeBracket.length),
      reverse(closeBracket),
      reverse(openBracket),
      false,
    );
    if (reversedIndex === -1) return -1;
    return text.length - (reversedIndex + openBracket.length);
  }
  let depth = 0;
  const stop = end ?? text.length;
  for (let i = start; i < stop; i++) {
    if (text.startsWith(openBracket, i)) depth++;
    else if (text.startsWith(closeBracket, i)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const OPEN: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
const CLOSE: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

export function getOpenBracket(closeBracket: string): string | undefined {
  return OPEN[closeBracket];
}

export function getCloseBracket(openBracket: string): string | undefined {
  return CLOSE[openBracket];
}
