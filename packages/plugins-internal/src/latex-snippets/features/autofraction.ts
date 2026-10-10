// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/features/autofraction.ts. Mudanças: devolve a expansão (aplicada por
// `cm/expand.ts` com a tecla `/`, uma transação) e procura o numerador só dentro do TeX da fórmula
// (não no documento inteiro até o cursor).
import type { EditorState, SelectionRange } from '@codemirror/state';
import {
  AUTOFRACTION_BREAKING_CHARS,
  AUTOFRACTION_EXCLUDED_ENVS,
  AUTOFRACTION_SYMBOL,
} from '../cm/config';
import type { SnippetExpansion } from '../cm/expand';
import { isWithinEnvironment, type LatexContext } from '../context';
import { findMatchingBracket, getOpenBracket } from './brackets';

const GREEK =
  'alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|zeta|eta|theta|Theta|iota|kappa|lambda|Lambda|mu|nu|omicron|xi|Xi|pi|Pi|rho|sigma|Sigma|tau|upsilon|Upsilon|varphi|phi|Phi|chi|psi|omega|Omega';
/** Espaço depois de letra grega faz parte do termo (`\alpha x/`): vira `#` só para a busca. */
const GREEK_SPACE = new RegExp(`(${GREEK}) ([^ ])`, 'g');

/** `x/` → `\frac{x}{$0}$1` para cada cursor (`null` = nenhum termo). */
export function findAutoFraction(
  state: EditorState,
  ctx: LatexContext,
): SnippetExpansion[] | null {
  const found: SnippetExpansion[] = [];
  for (const range of state.selection.ranges) {
    const expansion = runAutoFractionCursor(state, ctx, range);
    if (expansion) found.push(expansion);
  }
  return found.length > 0 ? found : null;
}

function runAutoFractionCursor(
  state: EditorState,
  ctx: LatexContext,
  range: SelectionRange,
): SnippetExpansion | null {
  const { from, to } = range;
  const math = ctx.math;
  if (!math) return null;
  if (AUTOFRACTION_EXCLUDED_ENVS.some((env) => isWithinEnvironment(ctx, to, env))) return null;
  const eqnStart = math.from;
  let start = eqnStart;
  if (from !== to) start = from;
  else {
    // O termo: tudo menos espaço e +-=, mas dentro de parênteses/colchetes/chaves vale tudo.
    const text = state.sliceDoc(eqnStart, to).replace(GREEK_SPACE, '$1#$2');
    for (let i = text.length - 1; i >= 0; i--) {
      const curChar = text.charAt(i);
      if (curChar === ')' || curChar === ']' || curChar === '}') {
        const open = getOpenBracket(curChar) ?? '';
        const j = findMatchingBracket(text, i, open, curChar, true);
        if (j === -1) return null;
        i = j;
      }
      if (` $([{\n${AUTOFRACTION_BREAKING_CHARS}`.includes(curChar)) {
        start = eqnStart + i + 1;
        break;
      }
    }
  }
  if (start === to) return null;
  let numerator = state.sliceDoc(start, to);
  // Sem os parênteses de fora: `(a+b)/` → `\frac{a+b}{}`.
  if (numerator.startsWith('(') && numerator.endsWith(')')) {
    if (findMatchingBracket(numerator, 0, '(', ')', false) === numerator.length - 1)
      numerator = numerator.slice(1, -1);
  }
  return {
    from: start,
    to,
    replacement: `${AUTOFRACTION_SYMBOL}{${numerator}}{$0}$1`,
    enlarge: true,
    // Com seleção, a seleção é o numerador e a tecla não entra (como um snippet visual).
    visual: from !== to,
  };
}
