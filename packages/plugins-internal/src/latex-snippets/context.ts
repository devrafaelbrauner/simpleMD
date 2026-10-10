import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { mathAt, type MathAt } from '../shared/scan';
import type { Environment } from './engine/environment';
import { Mode } from './engine/options';
import { findMatchingBracket, getCloseBracket } from './features/brackets';

/**
 * Contexto de uma tecla dos snippets LaTeX (r7 I-6, R-I6.1; arch-frontend §10.3, reescrito do
 * `src/utils/context.ts` do latex-suite, que lia os nós HyperMD do Obsidian): "matemática" =
 * `$…$`/`$$…$$` pelas MESMAS varreduras do KaTeX (`../shared/scan.ts`, `mathAt`); "texto" = o
 * resto; nada (contexto `null`) dentro de código, front matter ou HTML.
 */
export interface LatexContext {
  readonly state: EditorState;
  readonly pos: number;
  readonly mode: Mode;
  /** A fórmula em que o cursor está (`null` = texto). */
  readonly math: MathAt | null;
}

/** Nós em que nada expande; `true` = de bloco (o fim do bloco ainda é dentro). */
const EXCLUDED: Readonly<Record<string, boolean>> = {
  FrontMatter: true,
  FencedCode: true,
  CodeBlock: true,
  InlineCode: false,
  HTMLBlock: true,
  HTMLTag: false,
  CommentBlock: true,
  Comment: false,
  ProcessingInstructionBlock: true,
  ProcessingInstruction: false,
};

/** `pos` dentro de código, front matter ou HTML. */
export function excludedAt(state: EditorState, pos: number): boolean {
  let found = false;
  syntaxTree(state).iterate({
    from: pos,
    to: pos,
    enter(node) {
      if (found) return false;
      const block = EXCLUDED[node.name];
      if (block === undefined) return;
      if (node.from < pos && (pos < node.to || (block && pos === node.to))) found = true;
      return false;
    },
  });
  return found;
}

/** Contexto na posição (padrão: a ponta do cursor principal); `null` em código/front matter/HTML. */
export function contextAt(state: EditorState, pos = state.selection.main.to): LatexContext | null {
  if (excludedAt(state, pos)) return null;
  const math = mathAt(state, pos);
  const mode = new Mode();
  if (math) {
    mode.inlineMath = math.kind === 'inline';
    mode.blockMath = math.kind === 'block';
  } else mode.text = true;
  const ctx: LatexContext = { state, pos, mode, math };
  if (math) mode.textEnv = TEXT_ENVIRONMENTS.some((env) => isWithinEnvironment(ctx, pos, env));
  return ctx;
}

const TEXT_ENVIRONMENTS: readonly Environment[] = [
  { openSymbol: '\\text{', closeSymbol: '}' },
  { openSymbol: '\\tag{', closeSymbol: '}' },
  { openSymbol: '\\begin{', closeSymbol: '}' },
  { openSymbol: '\\end{', closeSymbol: '}' },
];

/**
 * `pos` está entre os símbolos do ambiente `env` dentro da fórmula atual (porte de
 * `Context.isWithinEnvironment` do latex-suite, sobre os limites do TeX de `mathAt`).
 */
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
