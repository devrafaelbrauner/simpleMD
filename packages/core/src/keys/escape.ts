import { closeCompletion, currentCompletions } from '@codemirror/autocomplete';
import { Facet, Prec, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** Donos do Escape antes do Vim (arch-ux §6.4): cartão do problema W2 (S5/S8) e paradas LaTeX (S6). */
export type EscapeOwner = 'card' | 'snippet';

interface EscapeHandler {
  readonly owner: EscapeOwner;
  run(view: EditorView): boolean;
}

const OWNER_ORDER: Record<EscapeOwner, number> = { card: 0, snippet: 1 };

export const escapeHandlerFacet = Facet.define<EscapeHandler>();

/** Registra um dono do Escape (pelo contexto do host: `host.editor.escape(owner, handler)`). */
export function escapeHandler(owner: EscapeOwner, run: (view: EditorView) => boolean): Extension {
  return escapeHandlerFacet.of({ owner, run });
}

/**
 * Árbitro do Escape antes do Vim (DA-R7-14, D-R7-F33; arch-frontend §4.2 camada 3): um
 * `domEventHandlers` em `Prec.highest` montado ANTES do compartimento de plugins, então roda antes
 * do `keydown` do Vim (mesma precedência, ordem de configuração). Ordem: popup VISÍVEL do
 * autocompletar (fecha) → W2 → paradas LaTeX → segue (painel do lint, Vim, `simplifySelection` do
 * CM). Só conta o popup aberto (com opções, mesmo que outra fonte ainda esteja pendente): consulta
 * pendente sem popup, ou resultado sem opções, faria `closeCompletion` devolver `true` e engolir o
 * Escape do dono seguinte. A saída do editor por Esc + Tab (2 s) é armada por um observador em
 * `tab-focus.ts`, que roda sempre.
 */
export const escapeArbiter: Extension = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event, view) {
      if (event.key !== 'Escape' || event.isComposing) return false;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
      const handlers = [...view.state.facet(escapeHandlerFacet)].sort(
        (a, b) => OWNER_ORDER[a.owner] - OWNER_ORDER[b.owner],
      );
      const popup = currentCompletions(view.state).length > 0 && closeCompletion(view);
      if (popup || handlers.some((handler) => handler.run(view))) {
        event.preventDefault();
        return true;
      }
      return false;
    },
  }),
);
