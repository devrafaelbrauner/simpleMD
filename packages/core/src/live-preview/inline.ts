import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import {
  DecorationContext,
  redecorate,
  type InlineContributor,
  type VisibleRange,
} from './context';
import { editorFocusField } from './focus';
import { linkReferences, linkReferencesField } from './references';

export interface InlineDriver {
  /** Função pura (R-3.3, R-I1.8): decorações das faixas dadas, sem despachar nada. */
  compute(state: EditorState, ranges: readonly VisibleRange[]): DecorationSet;
  /** `ViewPlugin` sobre `view.visibleRanges` (NFR-5, NFR-41). */
  readonly plugin: ViewPlugin<{ decorations: DecorationSet }>;
}

/**
 * Driver das decorações em linha (arch-frontend r7 §5.1): UMA `tree.iterate` por faixa visível,
 * com despacho nome → contribuidores (`Map`, montado uma vez). Um contribuidor que devolve `false`
 * impede a descida nos filhos (código, front matter, tabela, código em linha).
 */
export function createInlineDriver(contributors: readonly InlineContributor[]): InlineDriver {
  const byName = new Map<string, InlineContributor[]>();
  for (const contributor of contributors) {
    for (const name of contributor.nodes) {
      const list = byName.get(name);
      if (list) list.push(contributor);
      else byName.set(name, [contributor]);
    }
  }

  const compute = (state: EditorState, ranges: readonly VisibleRange[]): DecorationSet => {
    const tree = syntaxTree(state);
    const ctx = new DecorationContext(state, linkReferences(state));
    for (const range of ranges) {
      ctx.range = range;
      tree.iterate({
        from: range.from,
        to: range.to,
        enter: (ref) => {
          const list = byName.get(ref.name);
          if (!list) return undefined;
          const node = ref.node;
          let descend = true;
          for (const contributor of list)
            if (contributor.enter(node, ctx) === false) descend = false;
          return descend ? undefined : false;
        },
      });
    }
    return Decoration.set(ctx.out, true);
  };

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = compute(view.state, view.visibleRanges);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.startState.field(editorFocusField, false) !==
            update.state.field(editorFocusField, false) ||
          update.startState.field(linkReferencesField, false) !==
            update.state.field(linkReferencesField, false) ||
          syntaxTree(update.startState) !== syntaxTree(update.state) ||
          update.transactions.some((tr) => tr.effects.some((effect) => effect.is(redecorate)))
        ) {
          this.decorations = compute(update.state, update.view.visibleRanges);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

  return { compute, plugin };
}
