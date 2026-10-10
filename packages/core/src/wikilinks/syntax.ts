// Portado de silverbulletmd/silverbullet@70e58486e5e9d47dbfb13971e8576212896993c8 (MIT), © 2022 Zef Hemel. Modificado para o simpleMD.
// Origem: client/markdown_parser/parser.ts l.33–88 (`WikiLink`) e constants.ts (`wikiLinkRegex`).
// Mudanças: nós `WikiLinkTarget`/`WikiLinkHeading`/`WikiLinkAlias` (em vez de `WikiLinkPage`),
// título `#…` separado, apelido também depois de `\|` (wikilink dentro de tabela, D-R7-F16b), `!`
// anterior recusa (embeds `![[…]]` ficam crus, não-objetivo do r7), teto de 1.000 caracteres e
// nenhuma quebra de linha (R-I2.1).
import { tags } from '@lezer/highlight';
import type { InlineContext, MarkdownConfig } from '@lezer/markdown';

/** Teto do miolo `[[…]]` (R-I2.1): mais que isto fica texto. */
export const WIKILINK_MAX_CHARS = 1000;

/** Nomes dos nós Lezer do wikilink (arch-frontend r7 §6). */
export const WIKILINK_NODES = {
  link: 'WikiLink',
  mark: 'WikiLinkMark',
  target: 'WikiLinkTarget',
  heading: 'WikiLinkHeading',
  alias: 'WikiLinkAlias',
} as const;

const OPEN = 91; // [
const BANG = 33; // !
const BACKSLASH = 92;

/** Partes do miolo de `[[…]]` (posições relativas ao início do miolo). */
export interface WikilinkParts {
  readonly target: readonly [number, number];
  readonly heading: readonly [number, number] | null;
  /** Separador do apelido (`|` ou `\|`) e o apelido. */
  readonly pipe: readonly [number, number] | null;
  readonly alias: readonly [number, number] | null;
}

/**
 * Divide o miolo de um wikilink (sem `[[`/`]]`) em alvo, `#título` e `|apelido`. `null` = não é
 * wikilink: vazio, com quebra de linha ou colchete, apelido vazio, ou sem alvo e sem título.
 */
export function splitWikilink(inner: string): WikilinkParts | null {
  if (inner.length === 0 || inner.length > WIKILINK_MAX_CHARS) return null;
  if (/[\n\r[\]]/.test(inner)) return null;
  let pipeAt = -1;
  let pipeLen = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '|') {
      const escaped = i > 0 && inner.charCodeAt(i - 1) === BACKSLASH;
      pipeAt = escaped ? i - 1 : i;
      pipeLen = escaped ? 2 : 1;
      break;
    }
  }
  const head = pipeAt < 0 ? inner : inner.slice(0, pipeAt);
  const hash = head.indexOf('#');
  const target: readonly [number, number] = [0, hash < 0 ? head.length : hash];
  const heading: readonly [number, number] | null = hash < 0 ? null : [hash + 1, head.length];
  const alias: readonly [number, number] | null =
    pipeAt < 0 ? null : [pipeAt + pipeLen, inner.length];
  if (alias && inner.slice(alias[0], alias[1]).trim() === '') return null;
  const hasTarget = inner.slice(target[0], target[1]).trim() !== '';
  const hasHeading = heading !== null && inner.slice(heading[0], heading[1]).trim() !== '';
  if (!hasTarget && !hasHeading) return null;
  return {
    target,
    heading,
    pipe: pipeAt < 0 ? null : [pipeAt, pipeAt + pipeLen],
    alias,
  };
}

/** `!` antes de `[[` só é embed se não estiver escapado (número par de `\` antes dele; CR-S2-06). */
function embedBang(cx: InlineContext, pos: number): boolean {
  if (pos <= cx.offset || cx.char(pos - 1) !== BANG) return false;
  let slashes = 0;
  while (pos - 2 - slashes >= cx.offset && cx.char(pos - 2 - slashes) === BACKSLASH) slashes++;
  return slashes % 2 === 0;
}

/**
 * Contador de caracteres varridos atrás de crases (guarda estrutural de linearidade do CR-S2-09:
 * os testes conferem que fica proporcional ao texto, sem depender do relógio).
 */
export const wikilinkScan = { chars: 0 };

/**
 * Posição inicial da ÚLTIMA sequência de crases de cada comprimento no trecho em linha
 * (`[cx.offset, cx.end)`), calculada uma vez por `InlineContext` (CR-S2-09: antes cada `[[` copiava e
 * varria o resto do parágrafo — quadrático).
 */
const lastRunStart = new WeakMap<InlineContext, Map<number, number>>();

function lastRuns(cx: InlineContext): Map<number, number> {
  let runs = lastRunStart.get(cx);
  if (runs) return runs;
  runs = new Map();
  wikilinkScan.chars += cx.text.length;
  for (const match of cx.text.matchAll(/`+/g)) runs.set(match[0].length, cx.offset + match.index);
  lastRunStart.set(cx, runs);
  return runs;
}

/**
 * Um código em linha que abre no miolo e só fecha depois de `]]` (`end`) tem precedência
 * (CommonMark; CR-S2-06): `` [[a `b]] c` `` não é wikilink. Sequências de crases do miolo (≤ 1.000
 * caracteres) pareadas pelo comprimento, da esquerda para a direita (o que fica entre um par é
 * código); a primeira sem par fecha depois de `]]` se a última sequência desse comprimento no trecho
 * começa em `end` ou depois — O(1) pelo mapa do contexto.
 */
function codeSpanCrosses(inner: string, cx: InlineContext, end: number): boolean {
  wikilinkScan.chars += inner.length;
  const runs: number[] = [];
  for (const match of inner.matchAll(/`+/g)) runs.push(match[0].length);
  for (let i = 0; i < runs.length;) {
    const length = runs[i] as number;
    const pair = runs.indexOf(length, i + 1);
    if (pair < 0) return (lastRuns(cx).get(length) ?? -1) >= end;
    i = pair + 1;
  }
  return false;
}

function parseWikiLink(cx: InlineContext, next: number, pos: number): number {
  if (next !== OPEN || cx.char(pos + 1) !== OPEN) return -1;
  if (embedBang(cx, pos)) return -1;
  const limit = Math.min(cx.end, pos + 2 + WIKILINK_MAX_CHARS + 2);
  const rest = cx.slice(pos + 2, limit);
  const close = rest.indexOf(']]');
  if (close <= 0) return -1;
  const inner = rest.slice(0, close);
  const parts = splitWikilink(inner);
  if (!parts) return -1;
  if (inner.includes('`') && codeSpanCrosses(inner, cx, pos + 2 + close + 2)) return -1;
  const base = pos + 2;
  const end = base + close + 2;
  const children = [cx.elt(WIKILINK_NODES.mark, pos, base)];
  if (parts.target[1] > parts.target[0])
    children.push(cx.elt(WIKILINK_NODES.target, base + parts.target[0], base + parts.target[1]));
  if (parts.heading) {
    children.push(
      cx.elt(WIKILINK_NODES.mark, base + parts.heading[0] - 1, base + parts.heading[0]),
    );
    if (parts.heading[1] > parts.heading[0])
      children.push(
        cx.elt(WIKILINK_NODES.heading, base + parts.heading[0], base + parts.heading[1]),
      );
  }
  if (parts.pipe && parts.alias) {
    children.push(cx.elt(WIKILINK_NODES.mark, base + parts.pipe[0], base + parts.pipe[1]));
    children.push(cx.elt(WIKILINK_NODES.alias, base + parts.alias[0], base + parts.alias[1]));
  }
  children.push(cx.elt(WIKILINK_NODES.mark, end - 2, end));
  return cx.addElement(cx.elt(WIKILINK_NODES.link, pos, end, children));
}

/**
 * Extensão Lezer do wikilink (R-I2.1): `[[alvo]]`, `[[alvo|apelido]]`, `[[alvo\|apelido]]`,
 * `[[alvo#Título]]`, `[[alvo#Título|apelido]]`, `[[#Título]]`, `[[pasta/alvo]]`, `.md` opcional.
 * Código em linha/bloco e front matter não passam pelo parse em linha; `\[[` é um `Escape`. Usada
 * no editor (`markdownLanguageSupport`), na exportação e no índice: uma gramática só.
 */
export const wikiLinkSyntax: MarkdownConfig = {
  defineNodes: [
    { name: WIKILINK_NODES.link, style: tags.link },
    { name: WIKILINK_NODES.mark, style: tags.processingInstruction },
    { name: WIKILINK_NODES.target },
    { name: WIKILINK_NODES.heading },
    { name: WIKILINK_NODES.alias },
  ],
  parseInline: [{ name: WIKILINK_NODES.link, parse: parseWikiLink, after: 'Emphasis' }],
};
