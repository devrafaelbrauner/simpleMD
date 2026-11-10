import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { blockMathIn, scanInlineMath, type MathSpan, type Span } from './scan';

/**
 * A prosa de uma nota: o que é texto de leitura e em que língua ele está (design-r35 §1, r35b).
 * Comum ao LanguageTool (`data.annotation` do pedido) e ao corretor offline (o tokenizador): a
 * ESLint veda import entre pastas de plugin, então as regras ficam aqui, uma vez só.
 *
 * Unidade de verificação = bloco folha com texto: parágrafo (menos blocos `$$`), título, tarefa,
 * tabela. Dentro dela, o que não é texto verificável é `markup`: código, matemática, URLs, destinos
 * de links/wikilinks, HTML e as marcas de ênfase/lista/citação/tabela. Front matter, código cercado
 * e os demais blocos opacos nunca são unidade.
 */

export interface Unit {
  readonly from: number;
  readonly to: number;
}

/** Um pedaço de unidade: texto verificável OU marcação (a forma de `LtSegment`, sem `interpretAs`). */
export type ProseSegment = { readonly text: string } | { readonly markup: string };

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
      const overlaps =
        from === to ? node.from <= from && node.to >= to : node.to > from && node.from < to;
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
export function unitSegments(state: EditorState, from: number, to: number): ProseSegment[] {
  const doc = state.doc;
  const out: ProseSegment[] = [];
  let pos = from;
  for (const span of markupSpans(state, from, to)) {
    let end = span.to;
    const before =
      span.from === from ? 32 : doc.sliceString(span.from - 1, span.from).charCodeAt(0);
    if ((before === 32 || before === 9) && end < to && doc.sliceString(end, end + 1) === ' ') end++;
    if (span.from > pos) out.push({ text: doc.sliceString(pos, span.from) });
    out.push({ markup: doc.sliceString(span.from, end) });
    pos = end;
  }
  if (pos < to) out.push({ text: doc.sliceString(pos, to) });
  return out;
}

/** Mesma forma que o Rust aceita (`policy::is_language_code`): `xx[-Yy…]`, ≤ 35 bytes. */
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/;

/**
 * Normaliza um `lang` escrito à mão (`pt_br`, `PT-BR`, `"en-US"`) para a forma do LT
 * (`pt-BR`): primário minúsculo, região de 2 letras maiúscula, o resto como veio. `null` se não
 * tem a forma de um código.
 */
export function normalizeLanguage(raw: string): string | null {
  const parts = raw.trim().replace(/_/g, '-').split('-');
  const [primary = '', ...rest] = parts;
  const normalized = [
    primary.toLowerCase(),
    ...rest.map((part, i) => (i === 0 && /^[a-z]{2}$/i.test(part) ? part.toUpperCase() : part)),
  ].join('-');
  return normalized.length <= 35 && LANGUAGE_CODE.test(normalized) ? normalized : null;
}

/**
 * `lang:` do front matter (só a linha de topo `lang: valor`, aspas opcionais), normalizado. `null`
 * sem front matter, sem `lang` ou com valor que não é código de língua.
 */
export function frontMatterLang(state: EditorState): string | null {
  const node = syntaxTree(state).topNode.firstChild;
  if (node?.name !== 'FrontMatter') return null;
  const text = state.doc.sliceString(node.from, node.to);
  const match = /^lang[ \t]*:[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#]+))[ \t]*(?:#.*)?$/m.exec(
    text,
  );
  if (!match) return null;
  return normalizeLanguage(match[1] ?? match[2] ?? match[3] ?? '');
}
