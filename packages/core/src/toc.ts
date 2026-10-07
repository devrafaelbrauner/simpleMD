import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { headingLevel, headingText, NO_HEADING_BLOCKS } from './metadata/heading';

/** Uma entrada do sumário, aninhada pelo nível (R-9.5). */
export interface TocEntry {
  readonly level: number;
  readonly text: string;
  /** Início da linha do título no documento. */
  readonly from: number;
  readonly children: TocEntry[];
}

/** Orçamento do parse completo antes de cair na árvore atual (arch-frontend r2 §9: ≤ 30 ms). */
const PARSE_BUDGET_MS = 25;

/**
 * Sumário da nota (R-9.5): h1–h6 ATX e setext fora de blocos de código e do front matter, cada um
 * aninhado sob o título anterior de nível menor. Se o parse completo não couber no orçamento, usa
 * a árvore que o editor já tem (o painel recalcula no próximo debounce).
 */
export function computeToc(state: EditorState): TocEntry[] {
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state);
  const roots: TocEntry[] = [];
  const stack: TocEntry[] = [];
  tree.iterate({
    enter(node) {
      if (NO_HEADING_BLOCKS[node.name]) return false;
      const level = headingLevel(node.name);
      if (level === null) return undefined;
      const entry: TocEntry = {
        level,
        text: headingText(state.doc.sliceString(node.from, node.to), node.name),
        from: node.from,
        children: [],
      };
      while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) stack.pop();
      (stack.at(-1)?.children ?? roots).push(entry);
      stack.push(entry);
      return false;
    },
  });
  return roots;
}
