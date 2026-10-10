import { syntaxTree } from '@codemirror/language';
import type { EditorState, Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { noteContext } from '../assembly/note-context';
import {
  linkReferences,
  refKey,
  stripAngle,
  type LinkReferences,
} from '../live-preview/references';
import { classifyHref, type LinkTarget } from './target';

/** Um link lido da árvore: nó, texto visível, marcas a esconder e o destino classificado. */
export interface LinkInfo {
  readonly from: number;
  readonly to: number;
  /** Texto mostrado como link (o miolo de `[t]` ou a própria URL). */
  readonly textFrom: number;
  readonly textTo: number;
  /** Trechos de sintaxe escondidos fora do cursor (`[`, `](u)`, `<`, `>`). */
  readonly marks: readonly (readonly [number, number])[];
  /** Destino como escrito (sem `<>`; `www.` ganha `https://`; e-mail ganha `mailto:`). */
  readonly raw: string;
  readonly target: LinkTarget;
}

/** Nomes de nó que são link para o live preview (R-I1.1). */
export const LINK_NODES: readonly string[] = ['Link', 'Autolink', 'URL'];

/** URL "solta" fica de fora quando é parte de outro nó (destino de link, imagem, definição). */
const URL_OWNERS: Readonly<Record<string, true>> = {
  Link: true,
  Image: true,
  Autolink: true,
  LinkReference: true,
};

const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/;

/** Destino de autolink ou URL GFM como o navegador o entenderia (igual à exportação). */
function bareHref(text: string): string {
  if (/^www\./i.test(text)) return `https://${text}`;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text) && EMAIL.test(text)) return `mailto:${text}`;
  return text;
}

/**
 * Lê `node` (`Link`, `Autolink` ou `URL`) como link (R-I1.1). `null` = fica cru: referência sem
 * definição, link sem texto, destino com quebra de linha, URL que pertence a outro nó.
 */
export function readLink(
  node: SyntaxNode,
  doc: Text,
  refs: LinkReferences,
  notePath: string | null,
): LinkInfo | null {
  const make = (
    textFrom: number,
    textTo: number,
    marks: (readonly [number, number])[],
    raw: string,
  ): LinkInfo => ({
    from: node.from,
    to: node.to,
    textFrom,
    textTo,
    marks,
    raw,
    target: classifyHref(raw, notePath),
  });

  if (node.name === 'URL') {
    if (node.parent && URL_OWNERS[node.parent.name]) return null;
    return make(node.from, node.to, [], bareHref(doc.sliceString(node.from, node.to)));
  }

  if (node.name === 'Autolink') {
    const url = node.getChild('URL');
    if (!url) return null;
    return make(
      url.from,
      url.to,
      [
        [node.from, url.from],
        [url.to, node.to],
      ],
      bareHref(doc.sliceString(url.from, url.to)),
    );
  }

  if (node.name !== 'Link' || doc.sliceString(node.from, node.from + 1) !== '[') return null;
  let close: SyntaxNode | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'LinkMark' && doc.sliceString(child.from, child.to) === ']') {
      close = child;
      break;
    }
  }
  if (!close || close.from <= node.from + 1) return null;
  // Plugins não podem substituir quebras de linha: um destino com `\n` fica cru.
  if (doc.sliceString(close.from, node.to).includes('\n')) return null;
  let raw: string | undefined;
  const url = node.getChildren('URL').find((u) => u.from >= close.to);
  if (url) raw = stripAngle(doc.sliceString(url.from, url.to));
  else {
    const label = node.getChildren('LinkLabel').find((l) => l.from >= close.to);
    const key =
      label && label.to - label.from > 2
        ? doc.sliceString(label.from + 1, label.to - 1)
        : doc.sliceString(node.from + 1, close.from);
    raw = refs.get(refKey(key));
    if (raw === undefined) return null;
  }
  return make(
    node.from + 1,
    close.from,
    [
      [node.from, node.from + 1],
      [close.from, node.to],
    ],
    raw,
  );
}

/**
 * O link sob `pos` (cursor de "Abrir link sob o cursor", ponteiro do ⌘-clique e da dica W1): o nó
 * de link mais interno que contém `pos`, lido como no live preview.
 */
export function linkAt(state: EditorState, pos: number): LinkInfo | null {
  const refs = linkReferences(state);
  const notePath = state.facet(noteContext).path;
  for (const side of [1, -1] as const) {
    for (
      let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
      node;
      node = node.parent
    ) {
      if (!LINK_NODES.includes(node.name)) continue;
      if (pos < node.from || pos > node.to) continue;
      const info = readLink(node, state.doc, refs, notePath);
      if (info) return info;
    }
  }
  return null;
}
