import { Facet } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Alvo de "Interagir com o elemento sob o cursor" (UX-R7-D5, DA-R7-27): cartão de problema (W2,
 * lint/LT), widget de consulta (W3, tarefas), HTML (W4, núcleo). `order` crescente = quem tenta
 * primeiro (W2 10 → W3 20 → núcleo 30+); `run` devolve `true` quando assumiu a ação.
 */
export interface InteractHandler {
  readonly order: number;
  run(view: EditorView, pos: number): boolean;
}

export const interactFacet = Facet.define<InteractHandler>();

/**
 * Roda os alvos na cabeça da seleção principal, em ordem; o primeiro que aceita encerra. Sem alvo,
 * nada acontece (`false`). Comando `editor:interact` e tecla `Mod-Shift-Enter` (S1) chamam isto.
 */
export function runInteract(view: EditorView): boolean {
  const pos = view.state.selection.main.head;
  const handlers = [...view.state.facet(interactFacet)].sort((a, b) => a.order - b.order);
  return handlers.some((handler) => handler.run(view, pos));
}
