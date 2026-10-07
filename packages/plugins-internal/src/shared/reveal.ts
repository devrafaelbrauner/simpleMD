import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/**
 * Foco do editor guardado no estado, com a mesma regra do live preview do r1 (arch-frontend F-2):
 * só os módulos do host, sem importar o core. A revelação pelo cursor só vale com o editor focado.
 */
export const setPluginFocus = StateEffect.define<boolean>();

export const pluginFocusField = StateField.define<boolean>({
  create: () => false,
  update(focused, tr) {
    for (const effect of tr.effects) if (effect.is(setPluginFocus)) focused = effect.value;
    return focused;
  },
});

/**
 * Um estado trocado com `view.setState` (troca de aba) chega com o campo em `false` mesmo com o
 * editor focado; este plugin corrige a divergência logo depois (o `focusSync` do r1).
 */
const focusSync = ViewPlugin.fromClass(
  class {
    private destroyed = false;
    private scheduled = false;

    constructor(readonly view: EditorView) {
      this.check();
    }

    // O CodeMirror descarta a transação de foco agendada quando outra transação chega antes dela
    // (o `notifiedFocused` já mudou), e o campo ficaria velho até o próximo blur. Conferir a cada
    // atualização fecha essa janela (S2: plugins que despacham logo depois de abrir uma aba).
    update() {
      this.check();
    }

    check() {
      if (this.scheduled || this.view.hasFocus === this.view.state.field(pluginFocusField, false))
        return;
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (this.destroyed) return;
        const focused = this.view.hasFocus;
        if (focused !== this.view.state.field(pluginFocusField, false)) {
          this.view.dispatch({ effects: setPluginFocus.of(focused) });
        }
      });
    }

    destroy() {
      this.destroyed = true;
    }
  },
);

export const pluginFocus: Extension = [
  pluginFocusField,
  EditorView.focusChangeEffect.of((_state, focusing) => setPluginFocus.of(focusing)),
  focusSync,
];

/** Tocado = editor focado e alguma faixa da seleção encosta no intervalo (mesma regra do r1). */
export function isTouched(state: EditorState, from: number, to: number): boolean {
  if (!state.field(pluginFocusField, false)) return false;
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

export function focusChanged(update: ViewUpdate): boolean {
  return (
    update.startState.field(pluginFocusField, false) !== update.state.field(pluginFocusField, false)
  );
}

/**
 * Clique num widget: cursor no início da unidade e foco no editor; a unidade tocada passa a mostrar
 * a fonte (R-3.2). Usado pelos `mousedown` dos três plugins.
 */
export function revealAt(view: EditorView, pos: number): void {
  view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) } });
  view.focus();
}

/**
 * `mousedown` em qualquer elemento com `selector` dentro do conteúdo: revela a unidade cuja posição
 * é a do próprio widget (`posAtDOM`).
 */
export function revealOnMouseDown(selector: string): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as Element | null;
      const widget = target?.closest?.(selector);
      if (!widget || !view.contentDOM.contains(widget)) return false;
      event.preventDefault();
      revealAt(view, view.posAtDOM(widget));
      return true;
    },
  });
}

/** Ícone ⚠ monolinha (DESIGN §8.10), criado com a API do DOM; `aria-hidden`. */
export function warnGlyph(doc: Document): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of ['M12 3.5 21.5 20h-19z', 'M12 10v4M12 17h.01']) {
    const path = doc.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}
