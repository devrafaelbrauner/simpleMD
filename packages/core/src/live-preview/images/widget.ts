// Portado de retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715 (Apache-2.0), © Pranav Karawale. Modificado para o simpleMD.
// Origem: packages/ixora/src/state/image.ts (`ImagePreviewWidget`: espaço reservado até a imagem
// carregar, `eq` pelos dados da imagem). Mudanças: a imagem vem do serviço do app como URL `blob:`
// (nunca a URL do markdown), 6 estados com texto e nome acessível (DESIGN §R7.6.3), troca de `src`
// direto no DOM sem transação (`requestMeasure`), cancelamento da assinatura no `destroy`.
import { WidgetType, type EditorView } from '@codemirror/view';
import { imageSourceFacet, type ImageError, type ImageState } from './source';

/** O que o widget mostra: destino resolvido (ou a recusa decidida antes de ler) e o texto do nó. */
export interface ImageSpec {
  /** Caminho relativo ao vault (`null` quando a recusa veio antes de resolver). */
  readonly path: string | null;
  /** Destino como escrito (decodificado), para "Imagem não encontrada: <caminho>". */
  readonly shown: string;
  readonly alt: string;
  readonly title: string | null;
  /** Recusa sem leitura (fora da pasta, tipo); `null` = pedir ao serviço. */
  readonly error: ImageError | null;
  /** Dono na cache (caminho da nota). */
  readonly owner: string | null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** `i-warn` do r1 (mesmos traços), desenhado em linha: nenhum `href` dentro de `.cm-content`. */
const WARN_PATHS = ['M12 3.5 21.5 20h-19z', 'M12 10v4M12 17h.01'];

/** Texto da recusa (STR-146; grande demais pela extensão, F-07 do SN). */
function errorText(error: ImageError, spec: ImageSpec): string {
  switch (error) {
    case 'not-found':
      return `Imagem não encontrada: ${spec.shown}`;
    case 'outside':
      return 'Imagem fora da pasta';
    case 'bad-type':
      return 'Tipo de imagem não suportado';
    case 'too-large':
      return /\.svg$/i.test(spec.path ?? spec.shown)
        ? 'SVG maior que 2 MB'
        : 'Imagem maior que 20 MB';
  }
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function warnGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'cm-md-img-glyph');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of WARN_PATHS)
    svg.appendChild(document.createElementNS(SVG_NS, 'path')).setAttribute('d', d);
  return svg;
}

/** Cancelamentos das assinaturas por DOM do widget (o `destroy` do CM recebe o DOM). */
const subscriptions = new WeakMap<HTMLElement, () => void>();

/**
 * Imagem do vault (R-I1.7; DESIGN §R7.6.3; DA-R7-5): `<figure class="cm-md-img">` (bloco) ou
 * `<span class="cm-md-img cm-md-img-inline">` (em linha), `data-testid="cm-image"`, `data-state`
 * `loading|ok|not-found|outside|bad-type|too-large`. A leitura acontece só no `toDOM` (só imagens
 * desenhadas pagam; NFR-41). SVG só por `<img>`: o conteúdo nunca entra no DOM.
 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly spec: ImageSpec,
    readonly block: boolean,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    const a = this.spec;
    const b = other.spec;
    return (
      other.block === this.block &&
      a.path === b.path &&
      a.shown === b.shown &&
      a.alt === b.alt &&
      a.title === b.title &&
      a.error === b.error &&
      a.owner === b.owner
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement(this.block ? 'figure' : 'span');
    dom.className = this.block ? 'cm-md-img' : 'cm-md-img cm-md-img-inline';
    dom.dataset.testid = 'cm-image';
    const { spec } = this;
    if (spec.error !== null || spec.path === null) {
      this.#render(dom, { kind: 'error', error: spec.error ?? 'not-found' }, view);
      return dom;
    }
    const source = view.state.facet(imageSourceFacet);
    if (!source) {
      this.#render(dom, { kind: 'error', error: 'not-found' }, view);
      return dom;
    }
    const handle = source.request(spec.path, spec.owner);
    this.#render(dom, handle.state, view);
    subscriptions.set(
      dom,
      handle.subscribe((state) => {
        this.#render(dom, state, view);
        view.requestMeasure();
      }),
    );
    return dom;
  }

  override destroy(dom: HTMLElement): void {
    subscriptions.get(dom)?.();
    subscriptions.delete(dom);
  }

  /** Clique põe o cursor na fonte (revelação); nada mais é do widget. */
  override ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown';
  }

  #render(dom: HTMLElement, state: ImageState, view: EditorView): void {
    const { spec } = this;
    dom.removeAttribute('role');
    dom.removeAttribute('aria-label');
    dom.removeAttribute('aria-busy');
    if (state.kind === 'loading') {
      dom.dataset.state = 'loading';
      const label = spec.alt || fileName(spec.path ?? spec.shown);
      dom.setAttribute('role', 'img');
      dom.setAttribute('aria-label', `Carregando imagem: ${label}`);
      dom.setAttribute('aria-busy', 'true');
      dom.replaceChildren(label);
      return;
    }
    if (state.kind === 'ok') {
      dom.dataset.state = 'ok';
      const shown = dom.firstElementChild;
      if (shown instanceof HTMLImageElement) {
        shown.src = state.url;
        return;
      }
      const img = document.createElement('img');
      img.alt = spec.alt;
      if (spec.title !== null) img.title = spec.title;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener(
        'load',
        () => {
          view.requestMeasure();
          // Marca do harness (arch-ux §12.2; o `AppLogEvent` é do SN, só `performance.mark`).
          performance.mark('simplemd:image-painted');
        },
        { once: true },
      );
      img.src = state.url;
      dom.replaceChildren(img);
      return;
    }
    dom.dataset.state = state.error;
    const text = document.createElement('span');
    text.className = 'cm-md-img-text';
    text.textContent = errorText(state.error, spec);
    dom.replaceChildren(warnGlyph(), text);
  }
}
