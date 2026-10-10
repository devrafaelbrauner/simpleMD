import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState, type Range, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import { DecorationContext } from './context';
import { liveCounters } from './counters';
import { editorFocusField } from './focus';
import { linkReferences, linkReferencesField } from './references';

/** O que um contribuidor de bloco lê: estado, documento, definições, caminho da nota e revelação. */
export type BlockContext = Pick<
  DecorationContext,
  'state' | 'doc' | 'refs' | 'notePath' | 'isTouched'
>;

/**
 * Contribuidor de bloco (arch-frontend r7 §5.1): só filhos diretos do `Document`. `build` monta um
 * widget LEVE (o trabalho pesado fica no `toDOM`, chamado só para o que está desenhado).
 */
export interface BlockContributor {
  readonly nodes: readonly string[];
  build(node: SyntaxNode, ctx: BlockContext): Range<Decoration> | null;
}

export interface BlockDriver {
  /** Função pura: todas as decorações de bloco do estado (passada de topo, O(blocos de topo)). */
  compute(state: EditorState): DecorationSet;
  /** Campo incremental (§5.2): reconstrói só os blocos tocados pela edição ou pela seleção. */
  readonly field: StateField<DecorationSet>;
}

type Span = [from: number, to: number];

/** Início da linha do nó (o widget cobre a linha inteira mesmo com recuo). */
function lineStart(state: EditorState, pos: number): number {
  return state.doc.lineAt(pos).from;
}

/** Faixa coberta pelos blocos de topo de `tree` que encostam em `[from, to]`. */
function blockExtent(tree: Tree, from: number, to: number): Span {
  let start = from;
  let end = to;
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (node.type.isTop) return true;
      start = Math.min(start, node.from);
      end = Math.max(end, node.to);
      return false;
    },
  });
  return [start, end];
}

/** Junta faixas que se sobrepõem ou encostam (ordem crescente). */
function merge(spans: Span[]): Span[] {
  spans.sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
    else out.push([span[0], span[1]]);
  }
  return out;
}

export function createBlockDriver(contributors: readonly BlockContributor[]): BlockDriver {
  const byName = new Map<string, BlockContributor[]>();
  for (const contributor of contributors) {
    for (const name of contributor.nodes) {
      const list = byName.get(name);
      if (list) list.push(contributor);
      else byName.set(name, [contributor]);
    }
  }

  /** Monta os blocos de topo cujo início de linha cai em `[from, to]`. */
  const build = (state: EditorState, from: number, to: number, out: Range<Decoration>[]) => {
    const ctx = new DecorationContext(state, linkReferences(state));
    syntaxTree(state).iterate({
      from,
      to,
      enter: (ref) => {
        if (ref.type.isTop) return true;
        const list = byName.get(ref.name);
        if (list) {
          const start = lineStart(state, ref.from);
          if (start >= from && start <= to) {
            const node = ref.node;
            for (const contributor of list) {
              liveCounters.blockBuilds++;
              const range = contributor.build(node, ctx);
              if (range) out.push(range);
            }
          }
        }
        return false;
      },
    });
  };

  const compute = (state: EditorState): DecorationSet => {
    const out: Range<Decoration>[] = [];
    build(state, 0, state.doc.length, out);
    return Decoration.set(out, true);
  };

  /** Faixas (coordenadas novas) cujos blocos precisam ser refeitos nesta transação. */
  const staleSpans = (tr: Transaction): Span[] => {
    const before = syntaxTree(tr.startState);
    const after = syntaxTree(tr.state);
    const spans: Span[] = [];
    if (tr.docChanged) {
      tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        spans.push(blockExtent(after, fromB, toB));
        // A árvore velha cobre o caso de uma cerca que fecha: o que ela engolia volta a ser bloco.
        const [a, b] = blockExtent(before, fromA, toA);
        spans.push([tr.changes.mapPos(a, -1), tr.changes.mapPos(b, 1)]);
      });
    }
    const focusBefore = tr.startState.field(editorFocusField, false) ?? false;
    const focusAfter = tr.state.field(editorFocusField, false) ?? false;
    // Revelação (§5.2 c): blocos tocados pela seleção velha ou nova, só se o foco conta.
    if (
      (tr.selection || tr.docChanged || focusBefore !== focusAfter) &&
      (focusBefore || focusAfter)
    ) {
      for (const range of tr.startState.selection.ranges) {
        const from = tr.changes.mapPos(range.from, -1);
        const to = tr.changes.mapPos(range.to, 1);
        spans.push(blockExtent(after, from, to));
      }
      for (const range of tr.state.selection.ranges)
        spans.push(blockExtent(after, range.from, range.to));
    }
    return merge(spans.map(([a, b]) => [lineStart(tr.state, a), Math.min(b, tr.state.doc.length)]));
  };

  const field = StateField.define<DecorationSet>({
    create: compute,
    update(decorations, tr) {
      const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
      const refsChanged =
        tr.startState.field(linkReferencesField, false) !==
        tr.state.field(linkReferencesField, false);
      // Parse em segundo plano (§5.2 d) ou definição mudada: passada de topo, widgets leves.
      if (refsChanged || (treeChanged && !tr.docChanged)) return compute(tr.state);
      const spans = staleSpans(tr);
      if (spans.length === 0) return tr.docChanged ? decorations.map(tr.changes) : decorations;
      let next = tr.docChanged ? decorations.map(tr.changes) : decorations;
      for (const [from, to] of spans) {
        const out: Range<Decoration>[] = [];
        build(tr.state, from, to, out);
        next = next.update({
          filterFrom: from,
          filterTo: to,
          filter: (start) => start < from || start > to,
          add: out,
          sort: true,
        });
      }
      return next;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return { compute, field };
}
