import { Decoration } from '@codemirror/view';
import type { InlineContributor } from './context';

const frontMatterLine = Decoration.line({ class: 'cm-md-frontmatter' });
const frontMatterDelimLine = Decoration.line({
  class: 'cm-md-frontmatter cm-md-frontmatter-delim',
});

/**
 * Front matter (FME-CLASS): bloco de código YAML no topo, fundo `code-bg`, delimitadores `muted`, e
 * nenhuma decoração de markdown dentro (AC-9.11).
 */
export const frontMatter: InlineContributor = {
  nodes: ['FrontMatter'],
  enter(node, ctx) {
    const { doc, range } = ctx;
    const first = doc.lineAt(node.from).number;
    const last = doc.lineAt(node.to).number;
    const start = doc.lineAt(Math.max(node.from, range.from)).number;
    const end = doc.lineAt(Math.min(node.to, range.to)).number;
    for (let n = start; n <= end; n++) {
      const from = doc.line(n).from;
      if (!ctx.claimLine(from)) continue;
      ctx.out.push(
        (n === first || n === last ? frontMatterDelimLine : frontMatterLine).range(from),
      );
    }
    return false;
  },
};
