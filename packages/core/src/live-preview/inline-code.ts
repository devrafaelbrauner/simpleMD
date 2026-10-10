// Portado de retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715 (Apache-2.0), © Pranav Karawale. Modificado para o simpleMD.
// Origem: packages/ixora/src/plugins/hide-mark.ts (marcas `CodeMark` escondidas fora do cursor).
// Mudanças: contribuidor da passada única que não desce no código e marca o miolo `cm-md-code`.
import { Decoration } from '@codemirror/view';
import { hide, type InlineContributor } from './context';

const codeMark = Decoration.mark({ class: 'cm-md-code' });

/**
 * Código em linha (R-I1.5): crases (1 ou N) escondidas fora do cursor, miolo com `cm-md-code`.
 * Nunca desce: nenhuma decoração de markdown dentro do código, nem com o cursor nele.
 */
export const inlineCode: InlineContributor = {
  nodes: ['InlineCode'],
  enter(node, ctx) {
    if (!ctx.once(node) || ctx.isTouched(node.from, node.to)) return false;
    const marks = node.getChildren('CodeMark');
    const open = marks[0];
    const close = marks[marks.length - 1];
    if (!open || !close || open === close || open.to >= close.from) return false;
    ctx.out.push(hide.range(open.from, open.to));
    ctx.out.push(codeMark.range(open.to, close.from));
    ctx.out.push(hide.range(close.from, close.to));
    return false;
  },
};
