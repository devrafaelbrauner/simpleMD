// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/features/matrix_shortcuts.ts. Mudanças: Tab só chega aqui pela cadeia de contexto
// (chave "Tecla Tab no editor" ligada, R-I6.6); cada atalho é uma transação.
import type { EditorView } from '@codemirror/view';
import { MATRIX_SHORTCUTS_ENV_NAMES } from '../cm/config';
import type { LatexContext } from '../context';
import { isWithinEnvironment } from '../engine/context';
import { tabout } from './tabout';

/** Dentro de `matrix`/`pmatrix`/`bmatrix`/`array`/`align`/`cases`… */
export function insideMatrixEnv(ctx: LatexContext): boolean {
  return MATRIX_SHORTCUTS_ENV_NAMES.some((name) =>
    isWithinEnvironment(ctx, ctx.pos, {
      openSymbol: `\\begin{${name}}`,
      closeSymbol: `\\end{${name}}`,
    }),
  );
}

/** Tab → ` & `; Enter → ` \\ ` (+ nova linha no bloco); Shift-Enter sai da linha/da fórmula. */
export function runMatrixShortcuts(
  view: EditorView,
  ctx: LatexContext,
  key: 'Tab' | 'Enter',
  shiftKey: boolean,
): boolean {
  if (!insideMatrixEnv(ctx)) return false;
  if (key === 'Tab') {
    view.dispatch(view.state.replaceSelection(' & '), { userEvent: 'input', scrollIntoView: true });
    return true;
  }
  if (shiftKey && ctx.mode.blockMath) {
    const doc = view.state.doc;
    const line = doc.lineAt(ctx.pos);
    if (line.number >= doc.lines) return true;
    view.dispatch({ selection: { anchor: doc.line(line.number + 1).to }, scrollIntoView: true });
    return true;
  }
  if (shiftKey) return tabout(view, ctx);
  const lineBreak = ctx.mode.inlineMath ? ' \\\\ ' : ' \\\\\n';
  view.dispatch(view.state.replaceSelection(lineBreak), {
    userEvent: 'input',
    scrollIntoView: true,
  });
  return true;
}
