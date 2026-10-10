import type { Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import type { LinkInfo } from '../links/at-pos';
import { WIKILINK_NODES } from './syntax';

/** Um wikilink lido da árvore (arch-frontend r7 §6, `readWikilink`). */
export interface WikilinkInfo {
  readonly from: number;
  readonly to: number;
  /** Alvo como escrito, sem espaços nas pontas (`''` em `[[#Título]]`, a própria nota). */
  readonly target: string;
  /** Título pedido (`#…`), sem espaços nas pontas; `null` sem título. */
  readonly heading: string | null;
  /** Apelido (`|…` ou `\|…`), sem espaços nas pontas; `null` sem apelido. */
  readonly alias: string | null;
  /** Trechos do documento que formam o rótulo visível (apelido; ou alvo e título). */
  readonly targetRange: readonly [number, number] | null;
  readonly headingRange: readonly [number, number] | null;
  readonly aliasRange: readonly [number, number] | null;
}

type Source = Text | string;

const range = (node: SyntaxNode | null): readonly [number, number] | null =>
  node ? [node.from, node.to] : null;

/** Lê um nó `WikiLink` (o mesmo parser no editor, na exportação e no índice). */
export function readWikilink(node: SyntaxNode, doc: Source): WikilinkInfo {
  const targetNode = node.getChild(WIKILINK_NODES.target);
  const headingNode = node.getChild(WIKILINK_NODES.heading);
  const aliasNode = node.getChild(WIKILINK_NODES.alias);
  const text = (n: SyntaxNode | null) =>
    !n
      ? ''
      : (typeof doc === 'string' ? doc.slice(n.from, n.to) : doc.sliceString(n.from, n.to)).trim();
  const heading = text(headingNode);
  const alias = text(aliasNode);
  return {
    from: node.from,
    to: node.to,
    target: text(targetNode),
    heading: heading === '' ? null : heading,
    alias: alias === '' ? null : alias,
    targetRange: range(targetNode),
    headingRange: headingNode && heading !== '' ? range(headingNode) : null,
    aliasRange: range(aliasNode),
  };
}

/** Separador do rótulo `alvo › Título` (R-I2.2, AC-EX.3). */
export const WIKILINK_HEADING_SEPARATOR = ' › ';

/**
 * Rótulo visível (R-I2.2): apelido > `alvo › Título` > alvo; `[[#Título]]` mostra o título.
 */
export function wikilinkLabel(info: Pick<WikilinkInfo, 'target' | 'heading' | 'alias'>): string {
  if (info.alias !== null) return info.alias;
  if (info.heading === null) return info.target;
  return info.target === ''
    ? info.heading
    : `${info.target}${WIKILINK_HEADING_SEPARATOR}${info.heading}`;
}

/** Trecho do documento que fica visível como rótulo (o resto do nó é escondido). */
export function wikilinkLabelRange(info: WikilinkInfo): readonly [number, number] {
  if (info.aliasRange) return info.aliasRange;
  const from = info.targetRange?.[0] ?? info.headingRange?.[0] ?? info.from;
  const to = info.headingRange?.[1] ?? info.targetRange?.[1] ?? info.to;
  return [from, to];
}

/**
 * O wikilink como link do serviço de S1 (`linkAt`: ⌘/Ctrl-clique, "Abrir link sob o cursor", W1):
 * destino `wikilink`, resolvido pelo app ao abrir (R-I2.4).
 */
export function wikilinkAsLink(node: SyntaxNode, doc: Text, notePath: string | null): LinkInfo {
  const info = readWikilink(node, doc);
  const [textFrom, textTo] = wikilinkLabelRange(info);
  return {
    from: info.from,
    to: info.to,
    textFrom,
    textTo,
    marks: [
      [info.from, textFrom],
      [textTo, info.to],
    ],
    raw: info.target,
    target: { kind: 'wikilink', target: info.target, heading: info.heading, fromPath: notePath },
  };
}
