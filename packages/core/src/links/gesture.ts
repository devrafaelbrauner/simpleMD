import { Prec, type Extension } from '@codemirror/state';
import { EditorView, hoverTooltip, ViewPlugin } from '@codemirror/view';
import { appPlatformFacet, type EditorPlatform } from '../assembly/platform';
import { linkAt, type LinkInfo } from './at-pos';
import { linkOpenerFacet } from './opener';
import { targetLabel } from './target';
import { wikilinkTipParts, type TipPart } from '../live-preview/wikilinks';

/** Espera da dica W1 (UX-R7-D16): constante de comportamento, não de animação. */
export const LINK_TIP_DELAY_MS = 500;

/** O evento usa o modificador principal da plataforma, sem Alt (mesma regra de `hasMod` da UI). */
function hasMod(
  event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  platform: EditorPlatform,
): boolean {
  const mod =
    platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return mod && !event.altKey;
}

/** O link sob o ponteiro: o span renderizado (posição do DOM) ou, na fonte crua, as coordenadas. */
function linkUnder(view: EditorView, event: MouseEvent): LinkInfo | null {
  const span = (event.target as Element | null)?.closest?.('.cm-md-link');
  if (span && view.contentDOM.contains(span)) {
    const info = linkAt(view.state, view.posAtDOM(span));
    if (info) return info;
  }
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  return pos === null ? null : linkAt(view.state, pos);
}

/**
 * ⌘-clique (macOS) / Ctrl-clique (demais) sobre um link (R-I1.2, AC-I1.3, UX-R7-D15): abre UMA
 * vez pelo serviço do app e cancela o padrão do CM (nenhum cursor extra, seleção intacta). Clique
 * simples segue o CM (cursor e revelação). Fora de links, ⌘/Ctrl-clique continua somando cursor.
 */
const modClick = Prec.highest(
  EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !hasMod(event, view.state.facet(appPlatformFacet))) return false;
      const opener = view.state.facet(linkOpenerFacet);
      if (!opener) return false;
      const info = linkUnder(view, event);
      if (!info) return false;
      event.preventDefault();
      opener.open(info.target, view);
      return true;
    },
  }),
);

/** `clickAddsSelectionRange` (o primeiro valor vence): nunca sobre um link renderizado. */
const noRangeOverLinks = Prec.highest(
  EditorView.clickAddsSelectionRange.of((event) => {
    if ((event.target as Element | null)?.closest?.('.cm-md-link')) return false;
    return /Mac/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
  }),
);

/**
 * Classe `cm-md-mod` em `.cm-editor` enquanto a tecla Mod está pressionada (cursor de mão sobre
 * alvos de link; DESIGN §R7.6.1). Ouve a janela: o ponteiro pode estar sobre o editor sem foco.
 */
const modClass = ViewPlugin.fromClass(
  class {
    readonly #sync: (event: KeyboardEvent | MouseEvent) => void;
    readonly #clear: () => void;

    constructor(readonly view: EditorView) {
      this.#sync = (event) => {
        const on = hasMod(event, view.state.facet(appPlatformFacet));
        view.dom.classList.toggle('cm-md-mod', on);
      };
      this.#clear = () => view.dom.classList.remove('cm-md-mod');
      window.addEventListener('keydown', this.#sync, true);
      window.addEventListener('keyup', this.#sync, true);
      view.dom.addEventListener('mousemove', this.#sync);
      window.addEventListener('blur', this.#clear);
    }

    destroy() {
      window.removeEventListener('keydown', this.#sync, true);
      window.removeEventListener('keyup', this.#sync, true);
      this.view.dom.removeEventListener('mousemove', this.#sync);
      window.removeEventListener('blur', this.#clear);
    }
  },
);

/**
 * W1 (UX-R7-D16; DESIGN §R7.6.1): dica do CM depois de 500 ms sobre o link, com ou sem Mod:
 * destino (URL normalizada ou caminho resolvido; SN-SEC-03) + " · ⌘-clique para abrir"
 * (" · Ctrl-clique para abrir" fora do macOS). `role="tooltip"`, nunca focável; some ao mover o
 * ponteiro ou teclar.
 */
const linkTip = hoverTooltip(
  (view, pos) => {
    const info = linkAt(view.state, pos);
    if (!info) return null;
    return {
      pos: info.textFrom,
      end: info.textTo,
      above: false,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-md-link-tip';
        dom.setAttribute('role', 'tooltip');
        const mac = view.state.facet(appPlatformFacet) === 'mac';
        // Wikilink (S2): textos STR-148 (existente / ambíguo / inexistente).
        const parts: readonly TipPart[] =
          info.target.kind === 'wikilink'
            ? wikilinkTipParts(view.state, info.target.target, mac)
            : [
                { kind: 'dest', text: targetLabel(info.target, info.raw) },
                {
                  kind: 'hint',
                  text: mac ? ' · ⌘-clique para abrir' : ' · Ctrl-clique para abrir',
                },
              ];
        for (const part of parts) {
          const span = dom.appendChild(document.createElement('span'));
          span.className = `cm-md-link-tip-${part.kind}`;
          span.textContent = part.text;
        }
        return { dom };
      },
    };
  },
  { hoverTime: LINK_TIP_DELAY_MS, hideOnChange: true },
);

/** Gesto completo dos links do editor (arch-frontend r7 §5.5). */
export function linkGesture(): Extension {
  return [modClick, noRangeOverLinks, modClass, linkTip];
}
