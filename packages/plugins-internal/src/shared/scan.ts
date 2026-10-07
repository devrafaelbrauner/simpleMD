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
  if (doc.lineAt(node.from).from !== node.from) return null;
  const found = displayMathAt(doc.sliceString(node.from, doc.lineAt(node.to).to));
  return found && { from: node.from, to: node.from + found.end, tex: found.tex };
}

/**
 * A regra do bloco `$$` sobre o texto de um parágrafo (o editor e a exportação usam a mesma; R-7.3,
 * R-10.4): a primeira linha é só `$$` e uma linha seguinte — depois de pelo menos uma de conteúdo —
 * também. Devolve o TeX entre elas e o fim da linha de fechamento (offset no texto).
 */
export function displayMathAt(text: string): { tex: string; end: number } | null {
  if (!text.startsWith('$$')) return null;
  const openEnd = text.indexOf('\n');
  if (openEnd === -1 || text.slice(0, openEnd).trim() !== '$$') return null;
  const contentFrom = openEnd + 1;
  let start = text.indexOf('\n', contentFrom);
  while (start !== -1) {
    start++;
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    if (text.slice(start, end).trim() === '$$')
      return { tex: text.slice(contentFrom, start - 1), end };
    start = end === text.length ? -1 : end;
  }
  return null;
}

/**
 * Matemática em linha num texto de várias linhas (a exportação passa o texto de um bloco): a regra
 * de {@link scanInlineMath} aplicada linha a linha, com offsets relativos a `text`.
 */
export function inlineMathInText(text: string, blocked: readonly Span[]): MathSpan[] {
  const out: MathSpan[] = [];
  for (let start = 0; start <= text.length;) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    if (line.includes('$')) scanInlineMath(line, start, blocked, out);
    start = end + 1;
  }
  return out;
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
