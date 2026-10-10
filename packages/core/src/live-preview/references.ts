import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';

/** Definições `[r]: url` de topo: rótulo normalizado → destino como escrito (sem `<>`). */
export type LinkReferences = ReadonlyMap<string, string>;

/** Rótulo de referência normalizado (CommonMark: caixa e espaços não importam); igual na exportação. */
export function refKey(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Destino de link sem os `<>` opcionais. */
export function stripAngle(raw: string): string {
  return raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
}

function scan(state: EditorState): Map<string, string> {
  const refs = new Map<string, string>();
  const doc = state.doc;
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== 'LinkReference') continue;
    const label = node.getChild('LinkLabel');
    const url = node.getChild('URL');
    if (!label || !url) continue;
    const key = refKey(doc.sliceString(label.from + 1, label.to - 1));
    if (!refs.has(key)) refs.set(key, stripAngle(doc.sliceString(url.from, url.to)));
  }
  return refs;
}

/** Algum bloco de topo em `[from, to]` é uma definição? */
function touchesReference(tree: Tree, from: number, to: number): boolean {
  let found = false;
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (node.type.isTop) return !found;
      if (node.name === 'LinkReference') found = true;
      return false;
    },
  });
  return found;
}

function sameEntries(a: LinkReferences, b: LinkReferences): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * Mapa de definições (R-I1.1: referência só com definição). Recalculado só quando a transação toca
 * uma definição (na árvore velha ou na nova) ou quando a árvore cresce sem edição (parse em segundo
 * plano); sem mudança de conteúdo, o MESMO mapa continua (arch-frontend §12.1).
 */
export const linkReferencesField = StateField.define<LinkReferences>({
  create: scan,
  update(refs, tr) {
    const before = syntaxTree(tr.startState);
    const after = syntaxTree(tr.state);
    let stale = false;
    if (tr.docChanged) {
      tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        stale ||= touchesReference(before, fromA, toA) || touchesReference(after, fromB, toB);
      });
    } else stale = before !== after;
    if (!stale) return refs;
    const next = scan(tr.state);
    return sameEntries(refs, next) ? refs : next;
  },
});

/** As definições do estado (o campo, se o live preview está montado; senão, uma varredura). */
export function linkReferences(state: EditorState): LinkReferences {
  return state.field(linkReferencesField, false) ?? scan(state);
}
