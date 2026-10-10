// Portado de retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715 (Apache-2.0), © Pranav Karawale. Modificado para o simpleMD.
// Origem: packages/ixora/src/plugins/blockquote.ts (classe de linha por linha da citação e `>`
// trocados fora da linha do cursor). Mudanças: profundidade por linha (até 6), revelação por linha,
// marcas escondidas sem widget de borda (as barras são sombras internas do tema, D-R7-D03) e
// contribuidor da passada única.
import { Decoration } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { hide, type InlineContributor } from './context';

/** Níveis com barra própria; mais fundo mostra 6 barras (R-I1.6). */
const MAX_DEPTH = 6;

const depthLines = Array.from({ length: MAX_DEPTH }, (_, i) =>
  Decoration.line({ class: `cm-md-quote cm-md-quote-d${i + 1}` }),
);
/** Linha do cursor: mostra os `>` (`muted`) e perde recuo e barras (DA-R7-6). */
const cursorLine = Decoration.line({ class: 'cm-md-quote' });

const BLANK = /^[ \t]$/;

function insideQuote(node: SyntaxNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent.name === 'Blockquote') return true;
  return false;
}

/**
 * Citações (R-I1.6): ao entrar na citação mais externa, a profundidade de cada linha visível é a
 * da citação mais funda que a cobre (continuação preguiçosa inclusive). Fora da linha do cursor:
 * `cm-md-quote cm-md-quote-d<n>` e cada `>` com o espaço seguinte escondidos. Desce (o conteúdo da
 * citação segue decorado pelos outros contribuidores).
 */
export const blockquote: InlineContributor = {
  nodes: ['Blockquote'],
  enter(node, ctx) {
    // Sem `once`: cada faixa visível decora as suas linhas (a guarda de linha evita repetir).
    if (insideQuote(node)) return;
    const { doc, range } = ctx;
    const from = Math.max(node.from, range.from);
    const to = Math.min(node.to, range.to);
    if (from > to) return;
    const first = doc.lineAt(from).number;
    const depth = new Map<number, number>();
    const marks = new Map<number, SyntaxNode[]>();
    const cursor = node.cursor();
    let level = 0;
    const visit = (): void => {
      do {
        if (cursor.to < from || cursor.from > to) continue;
        const isQuote = cursor.name === 'Blockquote';
        if (isQuote) {
          level++;
          const start = Math.max(cursor.from, from);
          const end = Math.min(cursor.to, to);
          for (let n = doc.lineAt(start).number; n <= doc.lineAt(end).number; n++)
            depth.set(n, Math.max(depth.get(n) ?? 0, level));
        } else if (cursor.name === 'QuoteMark') {
          const n = doc.lineAt(cursor.from).number;
          const list = marks.get(n);
          if (list) list.push(cursor.node);
          else marks.set(n, [cursor.node]);
        }
        if (cursor.firstChild()) {
          visit();
          cursor.parent();
        }
        if (isQuote) level--;
      } while (cursor.nextSibling());
    };
    // A própria citação é o primeiro nível; o percurso desce pelos filhos dela.
    level = 1;
    for (let n = first; n <= doc.lineAt(to).number; n++) depth.set(n, 1);
    if (cursor.firstChild()) visit();

    for (const [n, d] of depth) {
      const line = doc.line(n);
      if (!ctx.claimLine(line.from, 'quote')) continue;
      if (ctx.isTouched(line.from, line.to)) {
        ctx.out.push(cursorLine.range(line.from));
        continue;
      }
      ctx.out.push(depthLines[Math.min(d, MAX_DEPTH) - 1]!.range(line.from));
      for (const mark of marks.get(n) ?? []) {
        let end = mark.to;
        if (end < line.to && BLANK.test(doc.sliceString(end, end + 1))) end++;
        ctx.out.push(hide.range(mark.from, end));
      }
    }
  },
};
