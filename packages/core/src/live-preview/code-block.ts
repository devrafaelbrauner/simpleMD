import { Decoration } from '@codemirror/view';
import type { InlineContributor } from './context';

const codeLine = Decoration.line({ class: 'cm-md-codeblock' });
const fenceDimMark = Decoration.mark({ class: 'cm-md-fence-dim' });

/**
 * Bloco cercado (R-3.1, AC-3.6): fundo de bloco em cada linha visível e cercas/linguagem atenuadas
 * fora do cursor. Não desce: nada de markdown é decorado dentro do código.
 */
export const codeBlock: InlineContributor = {
  nodes: ['FencedCode'],
  enter(node, ctx) {
    ctx.blockLines(node, codeLine);
    if (ctx.once(node) && !ctx.isTouched(node.from, node.to)) {
      for (const child of [...node.getChildren('CodeMark'), ...node.getChildren('CodeInfo')]) {
        ctx.out.push(fenceDimMark.range(child.from, child.to));
      }
    }
    return false;
  },
};
