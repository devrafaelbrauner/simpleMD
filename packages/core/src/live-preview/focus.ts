import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

/**
 * Foco do editor guardado NO estado (arch-frontend F-2): a revelação pelo cursor só acontece com
 * o editor focado, e as funções de decoração continuam sendo funções puras de `EditorState`.
 */
export const setEditorFocus = StateEffect.define<boolean>();

export const editorFocusField = StateField.define<boolean>({
  create: () => false,
  update(focused, tr) {
    for (const effect of tr.effects) if (effect.is(setEditorFocus)) focused = effect.value;
    return focused;
  },
});

/**
 * Um `EditorState` trocado com `view.setState` (troca de aba, recarga do disco) chega com o campo
 * em `false` mesmo com o editor focado, e o `focusChangeEffect` só dispara numa mudança de foco.
 * Este plugin nasce junto com cada estado novo e corrige a divergência logo depois.
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
      if (this.scheduled || this.view.hasFocus === this.view.state.field(editorFocusField, false))
        return;
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (this.destroyed) return;
        const focused = this.view.hasFocus;
        if (focused !== this.view.state.field(editorFocusField, false)) {
          this.view.dispatch({ effects: setEditorFocus.of(focused) });
        }
      });
    }

    destroy() {
      this.destroyed = true;
    }
  },
);

export function editorFocus(): Extension {
  return [
    editorFocusField,
    EditorView.focusChangeEffect.of((_state, focusing) => setEditorFocus.of(focusing)),
    focusSync,
  ];
}

/**
 * Um intervalo está "tocado" quando o editor está focado e alguma faixa da seleção encosta nele
 * (`r.from <= to && r.to >= from`, arch-frontend §2.4). Fora de foco, nada é revelado.
 */
export function isTouched(state: EditorState, from: number, to: number): boolean {
  if (!state.field(editorFocusField, false)) return false;
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}
