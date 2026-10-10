// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/features/run_snippets.ts. Mudanças: a busca devolve as expansões (a aplicação é
// `cm/expand.ts`, uma transação); os candidatos vêm do índice pelo último caractere e o texto
// testado é a janela de 100 caracteres antes do cursor (R-I6.7, NFR-56); sem modo de código.
import type { EditorState, SelectionRange } from '@codemirror/state';
import { SNIPPET_WINDOW } from '../catalog';
import { AUTO_ENLARGE_BRACKETS_TRIGGERS, WORD_DELIMITERS, type LatexSuiteSettings } from '../cm/config';
import type { SnippetExpansion } from '../cm/expand';
import { isWithinEnvironment, type LatexContext } from '../context';
import type { Mode, Options } from '../engine/options';

/**
 * Expansões para a tecla `key` (um caractere: snippets `A` e visuais; `'Tab'`: os demais, pelo
 * Tab da cadeia ou pelo comando "Expandir snippet LaTeX"). `null` = nenhum cursor casou.
 */
export function findSnippets(
  state: EditorState,
  ctx: LatexContext,
  key: string,
  settings: LatexSuiteSettings,
): SnippetExpansion[] | null {
  const found: SnippetExpansion[] = [];
  for (const range of state.selection.ranges) {
    const expansion = runSnippetCursor(state, ctx, key, range, settings);
    if (expansion) found.push(expansion);
  }
  return found.length > 0 ? found : null;
}

function runSnippetCursor(
  state: EditorState,
  ctx: LatexContext,
  key: string,
  range: SelectionRange,
  settings: LatexSuiteSettings,
): SnippetExpansion | null {
  const { from, to } = range;
  const sel = state.sliceDoc(from, to);
  const offset = Math.max(0, to - SNIPPET_WINDOW);
  const line = state.sliceDoc(offset, to);
  const typed = key.length === 1;
  const effective = typed ? { text: line + key, offset } : { text: line, offset };
  const last = typed ? key : line.slice(-1);
  if (!last) return null;
  for (const snippet of settings.catalog().candidates(last)) {
    if (!snippetShouldRunInMode(snippet.options, ctx.mode)) continue;
    // Automáticos e visuais só ao digitar; os demais só por Tab/comando.
    if ((snippet.options.automatic || snippet.type === 'visual') !== typed) continue;
    if (snippet.excludedEnvironments.some((env) => isWithinEnvironment(ctx, to, env))) continue;
    const result = snippet.process(effective, from, sel);
    if (result === null) continue;
    if (snippet.options.onWordBoundary && !isOnWordBoundary(state, result.triggerPos, to)) continue;
    let replacement = result.replacement;
    // Em linha, sem espaço no fim da substituição (`removeSnippetWhitespace`, padrão do upstream).
    if (ctx.mode.inlineMath) replacement = trimWhitespace(replacement);
    return {
      from: result.triggerPos,
      to,
      replacement,
      visual: snippet.type === 'visual',
      enlarge: AUTO_ENLARGE_BRACKETS_TRIGGERS.some((word) => replacement.includes(`\\${word}`)),
    };
  }
  return null;
}

export function snippetShouldRunInMode(options: Options, mode: Mode): boolean {
  if (
    ((options.mode.inlineMath && mode.inlineMath) || (options.mode.blockMath && mode.blockMath)) &&
    !mode.textEnv
  )
    return true;
  if (mode.inMath() && mode.textEnv && options.mode.text) return true;
  return options.mode.text && mode.text;
}

function isOnWordBoundary(state: EditorState, triggerPos: number, to: number): boolean {
  const prevChar = state.sliceDoc(triggerPos - 1, triggerPos);
  const nextChar = state.sliceDoc(to, to + 1);
  return WORD_DELIMITERS.includes(prevChar) && WORD_DELIMITERS.includes(nextChar);
}

/** Tira o espaço do fim (`… ` ou `… $N`) da substituição em matemática em linha. */
function trimWhitespace(replacement: string): string {
  if (replacement.endsWith(' ')) return replacement.trimEnd();
  const lastThree = replacement.slice(-3);
  if (lastThree.slice(0, 2) === ' $' && /\d/.test(lastThree.slice(-1)))
    return replacement.slice(0, -3) + replacement.slice(-2);
  return replacement;
}
