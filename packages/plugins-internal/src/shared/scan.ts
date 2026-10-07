import { syntaxTree } from '@codemirror/language';
import type { EditorState, Text } from '@codemirror/state';
import type { SyntaxNodeRef } from '@lezer/common';

/**
 * Varreduras compartilhadas por KaTeX e calc (arch-frontend r2 §7.1): o que é código ou front
 * matter (nada é renderizado lá) e onde está a matemática, pelas regras do Pandoc. Só a árvore de
 * sintaxe do módulo do host `@codemirror/language` e os nomes de nós do contrato v1 (docs/plugins.md).
 */
export interface Span {
  readonly from: number;
  readonly to: number;
}

export interface MathSpan extends Span {
  /** TeX sem os delimitadores. */
  readonly tex: string;
}

/** Nós em que nenhuma renderização acontece (R-7.3, R-7.4, R-9.1). */
const EXCLUDED: Record<string, true> = {
  FrontMatter: true,
  FencedCode: true,
  CodeBlock: true,
  InlineCode: true,
};

/** Nós excluídos que cruzam `[from, to]`, em ordem de posição. */
export function excludedSpans(state: EditorState, from: number, to: number): Span[] {
  const out: Span[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (!EXCLUDED[node.name]) return;
      out.push({ from: node.from, to: node.to });
      return false;
    },
  });
  return out;
}

/** `[from, to]` encosta em algum intervalo de `spans` (ordenados por `from`). */
export function insideAny(spans: readonly Span[], from: number, to: number): boolean {
  for (const span of spans) {
    if (span.from > to) return false;
    if (span.to >= from) return true;
  }
  return false;
}

/** Espaço, tab ou quebra de linha (charCode). */
const isSpace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;
const DOLLAR = 36;
const BACKSLASH = 92;

/**
 * Matemática em linha numa linha de texto, pelas regras do Pandoc (R-7.3): o `$` de abertura não é
 * seguido de espaço; o de fechamento não é precedido de espaço nem seguido de dígito; `\$` é um
 * cifrão literal; `$$` nunca abre matemática em linha. Uma unidade nunca cruza a linha nem um
 * intervalo bloqueado (código, front matter, bloco `$$`).
 */
export function scanInlineMath(
  text: string,
  offset: number,
  blocked: readonly Span[],
  out: MathSpan[],
): void {
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === BACKSLASH) {
      i += 2;
      continue;
    }
    if (code !== DOLLAR || insideAny(blocked, offset + i, offset + i)) {
      i++;
      continue;
    }
    if (text.charCodeAt(i + 1) === DOLLAR) {
      i += 2;
      continue;
    }
    if (i + 1 >= text.length || isSpace(text.charCodeAt(i + 1))) {
      i++;
      continue;
    }
    let close = -1;
    for (let j = i + 1; j < text.length; j++) {
      if (insideAny(blocked, offset + j, offset + j)) break;
      const c = text.charCodeAt(j);
      if (c === BACKSLASH) {
        j++;
        continue;
      }
      if (c !== DOLLAR) continue;
      const after = text.charCodeAt(j + 1);
      if (!isSpace(text.charCodeAt(j - 1)) && !(after >= 48 && after <= 57)) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      i++;
      continue;
    }
    out.push({ from: offset + i, to: offset + close + 1, tex: text.slice(i + 1, close) });
    i = close + 1;
  }
}

/**
 * Bloco `$$` (R-7.3): um parágrafo de topo cuja PRIMEIRA linha é só `$$` e uma linha seguinte do
 * mesmo parágrafo também só `$$`, com conteúdo entre elas. Devolve as linhas inteiras do bloco.
 */
function blockMathAt(doc: Text, node: SyntaxNodeRef): MathSpan | null {
  if (doc.sliceString(node.from, node.from + 2) !== '$$') return null;
  const open = doc.lineAt(node.from);
  if (open.from !== node.from || open.text.trim() !== '$$') return null;
  const last = doc.lineAt(node.to).number;
  for (let n = open.number + 2; n <= last; n++) {
    const line = doc.line(n);
    if (line.text.trim() === '$$') {
      return { from: open.from, to: line.to, tex: doc.sliceString(open.to + 1, line.from - 1) };
    }
  }
  return null;
}

/** Blocos `$$` de topo que cruzam `[from, to]` (O(blocos de topo visitados)). */
export function blockMathIn(state: EditorState, from: number, to: number): MathSpan[] {
  const doc = state.doc;
  const out: MathSpan[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === 'Document') return;
      if (node.name === 'Paragraph') {
        const block = blockMathAt(doc, node);
        if (block) out.push(block);
      }
      return false;
    },
  });
  return out;
}

/**
 * Matemática em linha nas linhas de `[from, to]`, fora de código, front matter e blocos `$$`
 * (`blocked`, ordenados por `from`).
 */
export function inlineMathIn(
  state: EditorState,
  from: number,
  to: number,
  blocked: readonly Span[],
): MathSpan[] {
  const doc = state.doc;
  const out: MathSpan[] = [];
  for (let pos = doc.lineAt(from).from; pos <= to;) {
    const line = doc.lineAt(pos);
    if (line.text.includes('$')) scanInlineMath(line.text, line.from, blocked, out);
    pos = line.to + 1;
  }
  return out;
}

/** Nós excluídos e blocos `$$` de `[from, to]`, juntos e ordenados (o que bloqueia calc e `$`). */
export function blockedSpans(state: EditorState, from: number, to: number): Span[] {
  return [...excludedSpans(state, from, to), ...blockMathIn(state, from, to)].sort(
    (a, b) => a.from - b.from,
  );
}
