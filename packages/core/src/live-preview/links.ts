// Portado de retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715 (Apache-2.0), © Pranav Karawale. Modificado para o simpleMD.
// Origem: packages/ixora/src/plugins/link.ts (marcas `[`/`](u)`/`<>` escondidas fora do cursor).
// Mudanças: contribuidor da passada única; referência só com definição; URL GFM solta; o link é
// um `span` com `role="link"`, nome com o destino e `data-href` — nunca `<a>`/`href`, nunca o
// ícone clicável do upstream (A-33, CF-R7-13); abrir é do gesto/comando (`links/`).
import { Decoration } from '@codemirror/view';
import { LINK_NODES, readLink } from '../links/at-pos';
import { linkAccessibleName, targetLabel } from '../links/target';
import { hide, type InlineContributor } from './context';

/**
 * Links (R-I1.1; DESIGN §R7.6.1): em linha, referência completa/colapsada/atalho (só com definição),
 * autolink e URL GFM. Fora do cursor: marcas escondidas e o texto com `cm-md-link`, `role="link"`,
 * `aria-label` STR-134 e `data-href`; sem `title` (o destino aparece na dica W1). Desce: ênfase e
 * imagem dentro do texto continuam decoradas.
 */
export const links: InlineContributor = {
  nodes: LINK_NODES,
  enter(node, ctx) {
    if (!ctx.once(node) || ctx.isTouched(node.from, node.to)) return;
    const info = readLink(node, ctx.doc, ctx.refs, ctx.notePath);
    if (!info) return;
    const text = ctx.doc.sliceString(info.textFrom, info.textTo);
    for (const [from, to] of info.marks) if (to > from) ctx.out.push(hide.range(from, to));
    ctx.out.push(
      Decoration.mark({
        class: 'cm-md-link',
        attributes: {
          role: 'link',
          'aria-label': linkAccessibleName(text, info.target, info.raw),
          'data-href': targetLabel(info.target, info.raw),
        },
      }).range(info.textFrom, info.textTo),
    );
  },
};
