import { Decoration, WidgetType } from '@codemirror/view';
import type { InlineContributor } from './context';

/** Marcador de lista renderizado: `•` com a largura de 1ch do caractere que substitui (AC-3.5). */
export class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-bullet';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = '•';
    return span;
  }
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const listNumberMark = Decoration.mark({ class: 'cm-md-list-number' });

/** Marcadores de lista (R-3.1): `•` no lugar de `-`/`*`/`+`, número atenuado; linha tocada → cru. */
export const lists: InlineContributor = {
  nodes: ['ListMark'],
  enter(node, ctx) {
    if (!ctx.once(node)) return;
    const list = node.parent?.parent?.name;
    const line = ctx.doc.lineAt(node.from);
    if (ctx.isTouched(line.from, line.to)) return;
    if (list === 'BulletList') ctx.out.push(bullet.range(node.from, node.to));
    else if (list === 'OrderedList') ctx.out.push(listNumberMark.range(node.from, node.to));
  },
};
