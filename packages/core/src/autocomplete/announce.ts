import { currentCompletions } from '@codemirror/autocomplete';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/**
 * Pausa antes de anunciar o número de sugestões (A11Y-R5-01): uma rajada de teclas vira um anúncio
 * só, depois da pausa, sem cortar o eco das teclas do leitor de tela.
 */
export const COMPLETION_ANNOUNCE_DELAY_MS = 300;

/** Texto do anúncio (AC-B14.1). */
export function completionAnnouncement(count: number): string {
  return count === 1 ? '1 sugestão, ↓ para escolher' : `${count} sugestões, ↓ para escolher`;
}

/**
 * A11Y-R5-01 (WCAG 4.1.3): com `selectOnOpen: false` (R4-02) o popup abre sem `aria-activedescendant`
 * e o leitor de tela não fala nada. Este plugin anuncia a contagem pela região polida do próprio
 * editor (`EditorView.announce`), num timer fora do caminho da tecla. A transação só tem o efeito:
 * não muda documento, estado do popup nem a opção ativa (Enter continua quebrando a linha). Setas
 * não mudam a contagem nem o documento, então não são anunciadas.
 */
export const completionAnnouncer = ViewPlugin.fromClass(
  class {
    private timer: number | undefined;
    private lastSeen = 0;
    private announced = 0;

    constructor(readonly view: EditorView) {}

    update(u: ViewUpdate) {
      const count = currentCompletions(u.state).length;
      if (count === 0) {
        window.clearTimeout(this.timer);
        this.announced = 0;
      } else if (u.docChanged || count !== this.lastSeen) {
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => this.announce(), COMPLETION_ANNOUNCE_DELAY_MS);
      }
      this.lastSeen = count;
    }

    announce() {
      const count = currentCompletions(this.view.state).length;
      if (count === 0 || count === this.announced) return;
      this.announced = count;
      this.view.dispatch({ effects: EditorView.announce.of(completionAnnouncement(count)) });
    }

    destroy() {
      window.clearTimeout(this.timer);
    }
  },
);
