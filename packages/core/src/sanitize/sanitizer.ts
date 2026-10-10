import DOMPurify, { type Config, type WindowLike } from 'dompurify';
import {
  ALLOWED_ATTR,
  ALLOWED_TAGS,
  ALLOWED_URI_REGEXP,
  attributeAllowedOn,
  attributeValue,
  DETAILS_FALLBACK,
  FORBID_ATTR,
  FORBID_CONTENTS,
  FORBID_TAGS,
  hrefAllowed,
  imageSourceCandidate,
} from './policy';
import { sanitizeStyle } from './style';

/**
 * Atributo onde o `src` relativo de um `<img>` fica estacionado depois da sanitização. O `src`
 * nunca sobrevive: quem consome (widget do editor, exportação) resolve o caminho no vault e
 * decide o que desenhar. Os `data-*` da nota já saíram (`ALLOW_DATA_ATTR: false`), então este só
 * pode ter vindo daqui.
 */
export const IMAGE_SOURCE_ATTR = 'data-smd-src';

/**
 * Sanitizador do HTML cru (R-I10.1; arch-frontend r7 §8): UMA instância do DOMPurify por janela,
 * com a política de `policy.ts`. O resultado é um fragmento do documento INERTE do DOMPurify (sem
 * contexto de navegação: nada carrega nem executa até alguém adotá-lo).
 */
export interface HtmlSanitizer {
  /**
   * Fragmento inerte com a política aplicada: só elementos/atributos da lista, `style`
   * re-serializado, `href` só nos esquemas da lista, comentários fora, todo `<img>` sem `src` (o
   * relativo fica em {@link IMAGE_SOURCE_ATTR}) e todo `<details>` com `<summary>` (STR-178).
   */
  toFragment(html: string): DocumentFragment;
  /**
   * Exportação (R-I10.4): o mesmo fragmento, com cada `<img>` estacionado trocado pelo `src` que
   * `image(raw)` devolver ou, sem ele, pelo texto alternativo (`.smd-img-alt`); serializado.
   * `''` quando nada exibível sobra.
   */
  toExportHtml(html: string, image: (raw: string) => string | null): string;
}

const CONFIG: Config & { RETURN_DOM_FRAGMENT: true } = {
  ALLOWED_TAGS: [...ALLOWED_TAGS],
  ALLOWED_ATTR: [...ALLOWED_ATTR],
  FORBID_TAGS: [...FORBID_TAGS],
  FORBID_ATTR: [...FORBID_ATTR],
  FORBID_CONTENTS: [...FORBID_CONTENTS],
  ALLOWED_URI_REGEXP,
  // `abbr` (em `th`) é texto, não URL.
  ADD_URI_SAFE_ATTR: ['abbr'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  ALLOW_SELF_CLOSE_IN_ATTR: false,
  SAFE_FOR_XML: true,
  SANITIZE_DOM: true,
  SANITIZE_NAMED_PROPS: true,
  KEEP_CONTENT: true,
  WHOLE_DOCUMENT: false,
  RETURN_DOM_FRAGMENT: true,
};

/** O fragmento tem algo para mostrar? (texto visível, imagem, régua ou quebra de linha). */
export function hasVisibleContent(root: ParentNode): boolean {
  return (root.textContent ?? '').trim() !== '' || root.querySelector('img, hr, br') !== null;
}

/** Comentários e instruções de processamento que tenham sobrado (defesa além do DOMPurify). */
function removeComments(root: DocumentFragment): void {
  const doc = root.ownerDocument;
  // 0x80 | 0x40 = SHOW_COMMENT | SHOW_PROCESSING_INSTRUCTION
  const walker = doc.createTreeWalker(root, 0x80 | 0x40);
  const doomed: Node[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) doomed.push(node);
  for (const node of doomed) node.parentNode?.removeChild(node);
}

export function createHtmlSanitizer(win: Window): HtmlSanitizer {
  // `Window` do DOM e `WindowLike` do DOMPurify descrevem o mesmo objeto; a tipagem não os une.
  const purify = DOMPurify(win as unknown as WindowLike);
  /** Documento inerte para o caso em que o parser não produz `<body>` (`<frameset>`). */
  const inert = win.document.implementation.createHTMLDocument('');
  /** `src` relativos lidos no gancho, por elemento (o atributo em si sai sempre). */
  let parked = new WeakMap<Element, string>();

  purify.addHook('uponSanitizeAttribute', (node, data) => {
    const tag = node.nodeName.toLowerCase();
    const name = data.attrName;
    if (name.startsWith('on') || name.startsWith('xlink:') || !attributeAllowedOn(name, tag)) {
      data.keepAttr = false;
      return;
    }
    const value = data.attrValue;
    switch (name) {
      case 'style': {
        const style = sanitizeStyle(value);
        if (style === '') data.keepAttr = false;
        else data.attrValue = style;
        return;
      }
      case 'href':
        if (!hrefAllowed(value)) data.keepAttr = false;
        return;
      case 'src':
        if (imageSourceCandidate(value)) parked.set(node, value);
        data.keepAttr = false;
        return;
      default: {
        const kept = attributeValue(name, value);
        if (kept === null) data.keepAttr = false;
        else data.attrValue = kept;
      }
    }
  });

  const toFragment = (html: string): DocumentFragment => {
    parked = new WeakMap();
    // `<frameset>` no início troca o `<body>` do documento de análise: o DOMPurify devolve `null`.
    const fragment =
      (purify.sanitize(html, CONFIG) as DocumentFragment | null) ??
      inert.createDocumentFragment();
    removeComments(fragment);
    const doc = fragment.ownerDocument;
    for (const img of fragment.querySelectorAll('img')) {
      const raw = parked.get(img);
      if (raw !== undefined) img.setAttribute(IMAGE_SOURCE_ATTR, raw);
    }
    for (const details of fragment.querySelectorAll('details')) {
      const first = details.firstElementChild;
      if (first?.localName === 'summary') continue;
      // Um `<summary>` que não é o primeiro filho não serve de rótulo: o agente de usuário poria
      // "Details" em inglês. O texto fica onde estava; o rótulo em português vem primeiro.
      const summary = doc.createElement('summary');
      summary.textContent = DETAILS_FALLBACK;
      details.prepend(summary);
    }
    parked = new WeakMap();
    return fragment;
  };

  const toExportHtml = (html: string, image: (raw: string) => string | null): string => {
    const fragment = toFragment(html);
    const doc = fragment.ownerDocument;
    for (const img of fragment.querySelectorAll('img')) {
      const raw = img.getAttribute(IMAGE_SOURCE_ATTR);
      img.removeAttribute(IMAGE_SOURCE_ATTR);
      const src = raw === null ? null : image(raw);
      if (src !== null) {
        img.setAttribute('src', src);
        continue;
      }
      const alt = img.getAttribute('alt') ?? '';
      if (alt === '') {
        img.remove();
        continue;
      }
      const span = doc.createElement('span');
      span.className = 'smd-img-alt';
      span.textContent = alt;
      img.replaceWith(span);
    }
    if (!hasVisibleContent(fragment)) return '';
    const holder = doc.createElement('div');
    holder.append(fragment);
    return holder.innerHTML;
  };

  return { toFragment, toExportHtml };
}
