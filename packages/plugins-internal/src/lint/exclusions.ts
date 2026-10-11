import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { blockedSpans, blockMathIn, inlineMathIn, type Span } from '../shared/scan';

/**
 * Trechos em que o lint nunca aponta nada (R-I5.1): `$…$` e `$$…$$` (as MESMAS varreduras do
 * KaTeX, `../shared/scan.ts`), blocos ```mermaid e expressões `=calc`. A regra de fronteira do
 * lint não alcança `../calc` nem `../mermaid` (D-R7-S5-03): as duas varreduras abaixo seguem as
 * deles (teste de paridade em `test/lint.test.ts`, "a varredura de calc do lint concorda…").
 */

/** Gramática do token calc (`calc/render.ts`, R-7.4): só algarismos, operadores e parênteses. */
const CALC_TOKEN = /^=[0-9.+\-*/%^()]+$/;
/** Um operador binário entre dois operandos (sem isso não há cálculo: `=5`, `=-3`, `=2+`). */
const CALC_BINARY = /[0-9.)][+\-*/%^][0-9.(+-]/;
const CALC_MAX_LENGTH = 200;

/** Tokens `=calc` de uma linha: `=` no início ou depois de espaço/tab, até o próximo espaço/tab. */
function calcSpans(text: string, offset: number, out: Span[]): void {
  for (let i = text.indexOf('='); i !== -1; i = text.indexOf('=', i + 1)) {
    if (i > 0 && text[i - 1] !== ' ' && text[i - 1] !== '\t') continue;
    let end = i + 1;
    while (end < text.length && text[end] !== ' ' && text[end] !== '\t') end++;
    const token = text.slice(i, end);
    if (token.length <= CALC_MAX_LENGTH && CALC_TOKEN.test(token) && CALC_BINARY.test(token))
      out.push({ from: offset + i, to: offset + end });
  }
}

/** Cercas ```mermaid que cruzam `[from, to]`, da linha da abertura ao fim da linha do fechamento. */
function mermaidSpans(state: EditorState, from: number, to: number, out: Span[]): void {
  const doc = state.doc;
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name !== 'FencedCode') return;
      const info = node.node.getChild('CodeInfo');
      if (info && doc.sliceString(info.from, info.to).trim().split(/\s/)[0] === 'mermaid')
        out.push({ from: doc.lineAt(node.from).from, to: doc.lineAt(node.to).to });
      return false;
    },
  });
}

/** Trechos excluídos que cruzam as linhas de `[from, to]`. */
export function excludedRegions(state: EditorState, from: number, to: number): Span[] {
  const start = state.doc.lineAt(from).from;
  const end = state.doc.lineAt(to).to;
  const out: Span[] = [...blockMathIn(state, start, end)];
  out.push(...inlineMathIn(state, start, end, blockedSpans(state, start, end)));
  mermaidSpans(state, start, end, out);
  for (let pos = start; pos <= end;) {
    const line = state.doc.lineAt(pos);
    if (line.text.includes('=')) calcSpans(line.text, line.from, out);
    pos = line.to + 1;
  }
  return out;
}

/** `[from, to]` está INTEIRO dentro de um trecho excluído. */
export function isExcluded(state: EditorState, from: number, to: number): boolean {
  return excludedRegions(state, from, to).some((span) => span.from <= from && to <= span.to);
}
