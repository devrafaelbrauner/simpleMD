// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/features/tabout.ts. Mudanças: limites da fórmula de `mathAt` (KaTeX); fórmula em
// linha ainda sem o `$` de fechamento não tem "depois" (devolve `false`); sair do bloco `$$` é uma
// transação só (cursor, linha nova e aparo).
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { LatexContext } from '../context';

const CLOSERS = '})]>|$';
const RANGLE = '\\rangle';

/** Tab no fim de um par sai dele; no fim da fórmula, sai da fórmula (só com a chave Tab). */
export function tabout(view: EditorView, ctx: LatexContext): boolean {
  const math = ctx.math;
  if (!math) return false;
  const { state } = view;
  const end = math.to;
  const pos = state.selection.main.to;
  const text = state.sliceDoc(pos, end);
  for (let i = 0; i < text.length; i++) {
    if (CLOSERS.includes(text.charAt(i))) {
      view.dispatch({ selection: { anchor: pos + i + 1 }, scrollIntoView: true });
      return true;
    }
    if (text.startsWith(RANGLE, i)) {
      view.dispatch({ selection: { anchor: pos + i + RANGLE.length }, scrollIntoView: true });
      return true;
    }
  }
  // No fim da fórmula (só espaço até o fim): sai dela.
  if (text.trim().length > 0 || !math.closed) return false;
  if (math.kind === 'inline') {
    view.dispatch({ selection: { anchor: end + 1 }, scrollIntoView: true });
    return true;
  }
  const doc = state.doc;
  const dollarLine = doc.lineAt(Math.min(end + 1, doc.length));
  const line = doc.lineAt(pos);
  const trimmed = line.text.trim();
  const changes = [
    ...(trimmed !== line.text ? [{ from: line.from, to: line.to, insert: trimmed }] : []),
    ...(dollarLine.number === doc.lines ? [{ from: dollarLine.to, insert: '\n' }] : []),
  ];
  const changeSet = state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: { anchor: changeSet.mapPos(dollarLine.to, -1) + 1 },
    scrollIntoView: true,
  });
  return true;
}

/** Digitar `)`/`]`/`}` logo antes do mesmo caractere passa por cima dele. */
export function shouldTaboutByCloseBracket(state: EditorState, keyPressed: string): boolean {
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const c = state.sliceDoc(sel.from, sel.from + 1);
  return c === keyPressed && (c === ')' || c === ']' || c === '}');
}
