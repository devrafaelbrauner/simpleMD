// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/utils/context.ts (`Context.isWithinEnvironment`, `Context.inTextEnvironment`).
// Mudanças: funções sobre o `LatexContext` do simpleMD; os limites da fórmula vêm de `mathAt` (as
// varreduras do KaTeX) em vez dos nós HyperMD do Obsidian.
import type { LatexContext } from '../context';
import { findMatchingBracket, getCloseBracket } from '../features/brackets';
import type { Environment } from './environment';

const TEXT_ENVIRONMENTS: readonly Environment[] = [
  { openSymbol: '\\text{', closeSymbol: '}' },
  { openSymbol: '\\tag{', closeSymbol: '}' },
  { openSymbol: '\\begin{', closeSymbol: '}' },
  { openSymbol: '\\end{', closeSymbol: '}' },
];

/** `pos` está entre os símbolos do ambiente `env` dentro da fórmula atual. */
export function isWithinEnvironment(ctx: LatexContext, pos: number, env: Environment): boolean {
  const { math } = ctx;
  if (!math) return false;
  const text = ctx.state.sliceDoc(math.from, math.to);
  const at = pos - math.from;
  const openBracket = env.openSymbol.slice(-1);
  const closeBracket = getCloseBracket(openBracket);
  // Abertura terminada em {, [ ou ( com o fechamento correspondente: o fechamento não é único.
  const bracketed = closeBracket !== undefined && env.closeSymbol === closeBracket;
  const offset = bracketed ? env.openSymbol.length - 1 : 0;
  const openSearch = bracketed ? openBracket : env.openSymbol;
  let left = text.lastIndexOf(env.openSymbol, at - 1);
  while (left !== -1) {
    const right = findMatchingBracket(text, left + offset, openSearch, env.closeSymbol, false);
    if (right === -1) return false;
    if (right >= at && at >= left + env.openSymbol.length) return true;
    if (left <= 0) return false;
    left = text.lastIndexOf(env.openSymbol, left - 1);
  }
  return false;
}

/** Dentro de `\text{}`, `\tag{}`, `\begin{}` ou `\end{}` da fórmula atual. */
export function inTextEnvironment(ctx: LatexContext): boolean {
  return TEXT_ENVIRONMENTS.some((env) => isWithinEnvironment(ctx, ctx.pos, env));
}
