// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/features/VerticalLines.ts (guias verticais por nível; clique dobra). Mudanças: a
// camada fica dentro do `.cm-scroller` (rola junto, sem espelhar o scroll), medida por
// `requestMeasure`; guia na x do centro do marcador do pai, da linha sob o pai ao último
// descendente (DESIGN §R7.6.13); clique dobra o item DONO da guia (R-I7.3); `title` STR-175;
// camada `aria-hidden`; sem Zoom nem classe no `body`.

import type { Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import type { OutlinerContext } from '../context';
import { MyEditor } from '../model/editor';
import type { List } from '../model/root';
import { OUTLINER_TEXT } from '../text';
import { itemLabel } from './folding';

/** Uma guia: o item dono (linha 0-based e marcador) e as linhas que ela cobre. */
export interface GuideSpec {
  readonly ownerLine: number;
  /** Deslocamento do primeiro caractere do marcador e o comprimento dele (`-`, `10.`…). */
  readonly bulletFrom: number;
  readonly bulletLength: number;
  readonly fromLine: number;
  readonly toLine: number;
  readonly title: string;
}

/** Guias dos itens com filhos visíveis entre as linhas `fromLine`…`toLine` (0-based). */
export function guideSpecs(
  ctx: OutlinerContext,
  editor: MyEditor,
  fromLine: number,
  toLine: number,
): GuideSpec[] {
  const out: GuideSpec[] = [];
  const visit = (list: List) => {
    if (list.isEmpty() || list.isFolded()) return;
    const ownerLine = list.getFirstLineContentStart().line;
    const ownerText = editor.getLine(ownerLine);
    out.push({
      ownerLine,
      bulletFrom: editor.posToOffset({ line: ownerLine, ch: list.getFirstLineIndent().length }),
      bulletLength: list.getBullet().length,
      fromLine: list.getLastLineContentEnd().line + 1,
      toLine: list.getContentEndIncludingChildren().line,
      title: OUTLINER_TEXT.foldGuide(itemLabel(ownerText)),
    });
    for (const child of list.getChildren()) visit(child);
  };
  for (const root of ctx.parser.parseRange(editor, fromLine, toLine))
    for (const child of root.getChildren()) visit(child);
  return out;
}

interface Placed {
  readonly spec: GuideSpec;
  readonly left: number;
  readonly top: number;
  readonly height: number;
}

/** Clique numa guia: dobra o item dono (`Item dobrado.`). */
export function foldGuideOwner(ctx: OutlinerContext, view: EditorView, spec: GuideSpec): void {
  new MyEditor(view).fold(spec.ownerLine);
  ctx.announce(OUTLINER_TEXT.folded);
}

export function guidesExtension(ctx: OutlinerContext): Extension {
  return ViewPlugin.define((view: EditorView) => {
    const layer = document.createElement('div');
    layer.className = 'cm-outliner-guides';
    layer.setAttribute('aria-hidden', 'true');
    view.scrollDOM.appendChild(layer);
    let placed: Placed[] = [];

    const measure = () =>
      view.requestMeasure({
        key: layer,
        read(): Placed[] {
          const editor = new MyEditor(view);
          const { doc } = view.state;
          const fromLine = doc.lineAt(view.viewport.from).number - 1;
          const toLine = doc.lineAt(view.viewport.to).number - 1;
          const scroller = view.scrollDOM.getBoundingClientRect();
          const originX = scroller.left - view.scrollDOM.scrollLeft;
          const originY = view.documentTop - scroller.top + view.scrollDOM.scrollTop;
          const out: Placed[] = [];
          for (const spec of guideSpecs(ctx, editor, fromLine, toLine)) {
            const start = view.coordsAtPos(spec.bulletFrom, 1);
            const end = view.coordsAtPos(spec.bulletFrom + spec.bulletLength, -1);
            if (!start || !end) continue;
            const top = view.lineBlockAt(doc.line(spec.fromLine + 1).from).top;
            const bottom = view.lineBlockAt(doc.line(spec.toLine + 1).from).bottom;
            if (bottom <= top) continue;
            out.push({
              spec,
              left: (start.left + end.left) / 2 - originX,
              top: top + originY,
              height: bottom - top,
            });
          }
          return out;
        },
        write(measured: Placed[]) {
          placed = measured;
          while (layer.children.length > placed.length) layer.lastElementChild?.remove();
          placed.forEach((guide, index) => {
            let element = layer.children[index] as HTMLElement | undefined;
            if (!element) {
              element = document.createElement('div');
              element.className = 'cm-outliner-guide';
              element.dataset.index = String(index);
              layer.appendChild(element);
            }
            element.style.left = `${guide.left}px`;
            element.style.top = `${guide.top}px`;
            element.style.height = `${guide.height}px`;
            element.title = guide.spec.title;
          });
        },
      });

    const onMouseDown = (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('.cm-outliner-guide');
      const guide = target ? placed[Number(target.dataset.index)] : undefined;
      if (!guide || event.button !== 0) return;
      event.preventDefault();
      foldGuideOwner(ctx, view, guide.spec);
    };
    layer.addEventListener('mousedown', onMouseDown);
    measure();

    return {
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.geometryChanged ||
          update.transactions.some((tr) => tr.reconfigured || tr.effects.length > 0)
        )
          measure();
      },
      destroy() {
        layer.removeEventListener('mousedown', onMouseDown);
        layer.remove();
      },
    };
  });
}
