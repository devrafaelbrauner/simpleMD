import { Prec, type Extension } from '@codemirror/state';
import { Direction, EditorView, layer, RectangleMarker } from '@codemirror/view';

/** Linhas com fundo de bloco (`code-bg`): bloco cercado, tabela revelada e front matter. */
export const BAND_LINE_CLASSES = ['cm-md-codeblock', 'cm-md-table-src', 'cm-md-frontmatter'];

const isBandLine = (el: Element): boolean =>
  BAND_LINE_CLASSES.some((cls) => el.classList.contains(cls));

/** Origem das coordenadas das camadas do CM (a mesma conta do `getBase` interno do pacote). */
function layerBase(view: EditorView): { left: number; top: number } {
  const rect = view.scrollDOM.getBoundingClientRect();
  const left =
    view.textDirection === Direction.LTR
      ? rect.left
      : rect.right - view.scrollDOM.clientWidth * view.scaleX;
  return {
    left: left - view.scrollDOM.scrollLeft * view.scaleX,
    top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
  };
}

/**
 * Um retângulo por sequência de linhas de bloco vizinhas no DOM do conteúdo: só a primeira e a
 * última linha de cada sequência são medidas (fase de medida do CM, layout já feito).
 */
export function codeBandMarkers(view: EditorView): RectangleMarker[] {
  const lines = view.contentDOM.children;
  const markers: RectangleMarker[] = [];
  let base: { left: number; top: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!isBandLine(lines[i]!)) continue;
    let last = i;
    while (last + 1 < lines.length && isBandLine(lines[last + 1]!)) last++;
    base ??= layerBase(view);
    const top = lines[i]!.getBoundingClientRect();
    const bottom = lines[last]!.getBoundingClientRect();
    markers.push(
      new RectangleMarker(
        'cm-md-band',
        top.left - base.left,
        top.top - base.top,
        top.width,
        bottom.bottom - top.top,
      ),
    );
    i = last;
  }
  return markers;
}

/**
 * Fundo `code-bg` das linhas de bloco numa camada ABAIXO da seleção (UIF-02; r1). Como fundo da
 * própria `.cm-line`, ele cobria a camada de seleção do CM (z −2) e a célula ativa da tabela (e
 * qualquer seleção em código) ficava invisível. `Prec.lowest` põe esta camada depois da seleção na
 * ordem das camadas, logo com z-index menor: a seleção (`selection`, P9) é pintada por cima do
 * fundo e o texto por cima dos dois. O redesenho segue o do CM: atualização da view do documento,
 * mudança de geometria, documento, viewport ou seleção (que revela/esconde a fonte da tabela).
 */
export const codeBandLayer: Extension = Prec.lowest(
  layer({
    above: false,
    class: 'cm-md-band-layer',
    markers: codeBandMarkers,
    update: (update) => update.docChanged || update.viewportChanged || update.selectionSet,
  }),
);
