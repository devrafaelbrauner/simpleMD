// Portado de retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715 (Apache-2.0), © Pranav Karawale. Modificado para o simpleMD.
// Origem: packages/ixora/src/plugins/hide-mark.ts (marcas `StrikethroughMark` escondidas fora do
// cursor). Mudanças: contribuidor da passada única (sem `toTree()` por nó) e classe `cm-md-strike`.
import { Decoration } from '@codemirror/view';
import { hide, type InlineContributor } from './context';

const strikeMark = Decoration.mark({ class: 'cm-md-strike' });

/** Tachado `~~x~~` (R-I1.4): `~~` escondidos fora do cursor, miolo com `line-through`. */
export const strikethrough: InlineContributor = {
  nodes: ['Strikethrough'],
  enter(node, ctx) {
    if (!ctx.once(node) || ctx.isTouched(node.from, node.to)) return;
    const marks = node.getChildren('StrikethroughMark');
    const first = marks[0];
    const last = marks[marks.length - 1];
    if (!first || !last || first === last || first.to >= last.from) return;
    ctx.out.push(hide.range(first.from, first.to));
    ctx.out.push(strikeMark.range(first.to, last.from));
    ctx.out.push(hide.range(last.from, last.to));
  },
};
