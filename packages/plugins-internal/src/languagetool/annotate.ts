import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { LtSegment } from '@simplemd/plugin-api/internal/languagetool';
import { blockMathIn, scanInlineMath, type MathSpan, type Span } from '../shared/scan';

/**
 * Do documento para o `data.annotation` do LanguageTool (R-I8.3, AC-I8.3; JEV D-R7-S8-01 A).
 *
 * Unidade de verificação = bloco folha com texto: parágrafo (menos blocos `$$`), título, tarefa,
 * tabela. Um pedido cobre UM intervalo contíguo do documento; dentro dele, o que não é texto
 * verificável vai como `markup` literal (deslocamentos preservados: posição no documento =
 * início do intervalo + `offset` da resposta, conferido no LT 6.8 real): front matter, código,
 * matemática, URLs, destinos de links/wikilinks, HTML, marcas de ênfase/lista/citação/tabela e os
 * blocos entre unidades (com `interpretAs: "\n\n"`, a quebra de parágrafo que o LT entende).
 */

/** Teto de unidades UTF-16 por pedido (texto + markup), o mesmo do Rust (`policy::MAX_UNITS`). */
export const MAX_REQUEST_UNITS = 20_000;

export interface Unit {
  readonly from: number;
  readonly to: number;
}

/** Blocos folha cujo texto é verificado. */
const UNIT_NODES: Record<string, true> = {
  Paragraph: true,
  ATXHeading1: true,
  ATXHeading2: true,
  ATXHeading3: true,
  ATXHeading4: true,
  ATXHeading5: true,
  ATXHeading6: true,
  SetextHeading1: true,
  SetextHeading2: true,
  Task: true,
  Table: true,
};

/** Blocos que nunca têm texto verificável (não se desce neles). */
const OPAQUE_BLOCKS: Record<string, true> = {
  FrontMatter: true,
  FencedCode: true,
  CodeBlock: true,
  HTMLBlock: true,
  CommentBlock: true,
  ProcessingInstructionBlock: true,
  LinkReference: true,
  HorizontalRule: true,
};

/**
 * Nós em linha que viram `markup` (inteiros). Os textos visíveis de links, wikilinks com apelido,
 * ênfase e células ficam como texto.
 */
const MARKUP_NODES: Record<string, true> = {
  InlineCode: true,
  URL: true,
  Autolink: true,
  LinkMark: true,
  LinkTitle: true,
  LinkLabel: true,
  Image: true,
  HTMLTag: true,
  Comment: true,
  ProcessingInstruction: true,
  WikiLinkMark: true,
  WikiLinkTarget: true,
  WikiLinkHeading: true,
  HeaderMark: true,
  EmphasisMark: true,
  StrikethroughMark: true,
  QuoteMark: true,
  ListMark: true,
  TaskMarker: true,
  TableDelimiter: true,
};

/** Unidades que cruzam `[from, to]`, em ordem (blocos `$$` ficam de fora: são matemática). */
export function unitsIn(state: EditorState, from: number, to: number): Unit[] {
  const math = blockMathIn(state, from, to);
  const out: Unit[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      // Intervalo vazio (apagamento): a unidade que contém o ponto; senão, só sobreposição real.
      const overlaps = from === to ? node.from <= from && node.to >= to : node.to > from && node.from < to;
      if (!overlaps) return false;
      if (OPAQUE_BLOCKS[node.name]) return false;
      if (!UNIT_NODES[node.name]) return;
      if (!math.some((m) => m.from === node.from)) out.push({ from: node.from, to: node.to });
      return false;
    },
  });
  return out;
}

/** Trechos `markup` dentro de `[from, to)`, ordenados e fundidos. */
function markupSpans(state: EditorState, from: number, to: number): Span[] {
  const spans: Span[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.to <= from || node.from >= to) return false;
      if (!MARKUP_NODES[node.name]) return;
      spans.push({ from: Math.max(node.from, from), to: Math.min(node.to, to) });
      return false;
    },
  });
  // Matemática em linha `$…$` (as mesmas regras do KaTeX), fora do que já é markup.
  const doc = state.doc;
  const blocked = [...spans].sort((a, b) => a.from - b.from);
  const math: MathSpan[] = [];
  for (let pos = from; pos < to;) {
    const line = doc.lineAt(pos);
    const start = Math.max(line.from, from);
    const end = Math.min(line.to, to);
    const text = doc.sliceString(start, end);
    if (text.includes('$')) scanInlineMath(text, start, blocked, math);
    pos = line.to + 1;
  }
  return merge([...spans, ...math]);
}

function merge(spans: Span[]): Span[] {
  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  const out: { from: number; to: number }[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else out.push({ from: span.from, to: span.to });
  }
  return out;
}

/**
 * Segmentos de UMA unidade (ou pedaço dela): texto e markup alternados, cobrindo `[from, to)`
 * inteiro. Um markup entre espaços leva o espaço seguinte, para o LT não ver espaço duplo onde o
 * leitor vê uma palavra (`Use \`x\` aqui` → texto "Use aqui").
 */
export function unitSegments(state: EditorState, from: number, to: number): LtSegment[] {
  const doc = state.doc;
  const out: LtSegment[] = [];
  let pos = from;
  for (const span of markupSpans(state, from, to)) {
    let end = span.to;
    const before = span.from === from ? 32 : doc.sliceString(span.from - 1, span.from).charCodeAt(0);
    if ((before === 32 || before === 9) && end < to && doc.sliceString(end, end + 1) === ' ') end++;
    if (span.from > pos) out.push({ text: doc.sliceString(pos, span.from) });
    out.push({ markup: doc.sliceString(span.from, end) });
    pos = end;
  }
  if (pos < to) out.push({ text: doc.sliceString(pos, to) });
  return out;
}

/** Um pedido pronto: intervalo do documento, segmentos e as unidades que ele verifica. */
export interface PlannedRequest {
  readonly from: number;
  readonly to: number;
  readonly units: readonly Unit[];
  readonly annotation: readonly LtSegment[];
}

/**
 * Divide uma unidade maior que o teto por linhas e, se uma linha sozinha passa do teto, por
 * posições (sem partir um par substituto, de preferência num espaço).
 */
export function splitUnit(state: EditorState, unit: Unit, max = MAX_REQUEST_UNITS): Unit[] {
  if (unit.to - unit.from <= max) return [unit];
  const doc = state.doc;
  const out: Unit[] = [];
  let start = unit.from;
  while (unit.to - start > max) {
    let cut = doc.lineAt(start + max).from - 1; // fim da última linha inteira que cabe
    if (cut <= start) {
      cut = start + max;
      const window = doc.sliceString(start, cut);
      const space = window.lastIndexOf(' ');
      if (space > max / 2) cut = start + space + 1;
      const code = doc.sliceString(cut - 1, cut).charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
    }
    out.push({ from: start, to: cut });
    start = cut;
    while (start < unit.to && doc.sliceString(start, start + 1) === '\n') start++;
  }
  if (start < unit.to) out.push({ from: start, to: unit.to });
  return out;
}

/**
 * Agrupa as unidades (ordenadas) em pedidos de intervalo contíguo ≤ `max` unidades UTF-16. Entre
 * duas unidades do mesmo pedido, o que houver vai como markup de bloco. O primeiro pedido começa
 * em 0 quando a primeira unidade é a primeira da nota (o front matter vai como markup, AC-I8.3)
 * e isso cabe no teto.
 */
export function planRequests(
  state: EditorState,
  units: readonly Unit[],
  max = MAX_REQUEST_UNITS,
): PlannedRequest[] {
  const pieces = units.flatMap((u) => splitUnit(state, u, max));
  const firstUnit = unitsIn(state, 0, state.doc.length)[0];
  const groups: Unit[][] = [];
  for (const piece of pieces) {
    const group = groups[groups.length - 1];
    if (group && piece.to - (group[0] as Unit).from <= max) group.push(piece);
    else groups.push([piece]);
  }
  return groups.map((group) => {
    const head = group[0] as Unit;
    const last = group[group.length - 1] as Unit;
    const from =
      firstUnit && head.from === firstUnit.from && last.to <= max && head.from > 0 ? 0 : head.from;
    const annotation: LtSegment[] = [];
    let pos = from;
    for (const unit of group) {
      if (unit.from > pos)
        annotation.push({ markup: state.doc.sliceString(pos, unit.from), interpretAs: '\n\n' });
      annotation.push(...unitSegments(state, unit.from, unit.to));
      pos = unit.to;
    }
    return { from, to: last.to, units: group, annotation };
  });
}
