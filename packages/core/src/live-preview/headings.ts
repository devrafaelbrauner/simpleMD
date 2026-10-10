import { Decoration } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { hide, type DecorationContext, type InlineContributor } from './context';

const headingLines = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-md-h${level}` }),
);

const BLANK = /^[ \t]$/;

/** Esconde `#…# ` no início e, se houver, ` #…#` no fim (título ATX fechado). */
function hideHeaderMarks(node: SyntaxNode, lineEnd: number, ctx: DecorationContext): void {
  const { doc, out } = ctx;
  let hiddenUpTo = node.from;
  for (const mark of node.getChildren('HeaderMark')) {
    if (mark.from === node.from) {
      let end = mark.to;
      while (end < lineEnd && BLANK.test(doc.sliceString(end, end + 1))) end++;
      out.push(hide.range(mark.from, end));
      hiddenUpTo = end;
    } else {
      let start = mark.from;
      while (start > hiddenUpTo && BLANK.test(doc.sliceString(start - 1, start))) start--;
      if (mark.to > start) out.push(hide.range(start, mark.to));
    }
  }
}

/** Títulos ATX (R-3.1): classe de nível na linha (fica ao revelar) e marcas escondidas fora dela. */
export const headings: InlineContributor = {
  nodes: [1, 2, 3, 4, 5, 6].map((level) => `ATXHeading${level}`),
  enter(node, ctx) {
    if (!ctx.once(node)) return;
    const line = ctx.doc.lineAt(node.from);
    const level = Number(node.name.slice('ATXHeading'.length));
    // A classe de nível fica sempre, para o tamanho da linha não pular ao revelar.
    ctx.out.push((headingLines[level - 1] ?? headingLines[0]!).range(line.from));
    if (!ctx.isTouched(line.from, line.to)) hideHeaderMarks(node, line.to, ctx);
  },
};
