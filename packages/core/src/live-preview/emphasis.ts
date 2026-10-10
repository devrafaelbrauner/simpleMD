import { Decoration } from '@codemirror/view';
import { hide, type InlineContributor } from './context';

const strongMark = Decoration.mark({ class: 'cm-md-strong' });
const emMark = Decoration.mark({ class: 'cm-md-em' });

/** Negrito e itálico (R-3.1): marcas escondidas e o miolo com a classe, fora do cursor. */
export const emphasis: InlineContributor = {
  nodes: ['Emphasis', 'StrongEmphasis'],
  enter(node, ctx) {
    if (!ctx.once(node) || ctx.isTouched(node.from, node.to)) return;
    const marks = node.getChildren('EmphasisMark');
    const first = marks[0];
    const last = marks[marks.length - 1];
    if (!first || !last || first === last || first.to >= last.from) return;
    for (const mark of marks) ctx.out.push(hide.range(mark.from, mark.to));
    ctx.out.push((node.name === 'Emphasis' ? emMark : strongMark).range(first.to, last.from));
  },
};
