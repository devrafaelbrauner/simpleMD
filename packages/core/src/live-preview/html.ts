import { syntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { Decoration, WidgetType, type EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { appPlatformFacet } from '../assembly/platform';
import { interactFacet } from '../keys/interact';
import { linkOpenerFacet } from '../links/opener';
import { classifyHref, linkAccessibleName, targetLabel, type LinkTarget } from '../links/target';
import { resolveVaultPath } from '../links/vault-path';
import { SanitizeCache } from '../sanitize/cache';
import { ALLOWED_TAGS, EMPTY_HTML_TEXT } from '../sanitize/policy';
import { createHtmlSanitizer, hasVisibleContent, IMAGE_SOURCE_ATTR } from '../sanitize/sanitizer';
import type { BlockContributor } from './block';
import type { DecorationContext, InlineContributor } from './context';
import { editorFocusField, setEditorFocus } from './focus';
import { ImageWidget, type ImageSpec } from './images/widget';

/**
 * HTML cru no editor (I-10; R-I10.2/R-I10.3; DESIGN §R7.6.15; arch-ux §3.9; DA-R7-18): bloco
 * `HTMLBlock` de topo → widget de bloco com moldura; tags em linha balanceadas no mesmo parágrafo →
 * widget em linha sem moldura; desbalanceadas, cru; cursor dentro → cru. O conteúdo passa pela
 * política única (`sanitize/`) e só então pela lista fechada de transformações do editor.
 */

const ALLOWED: Readonly<Record<string, true>> = Object.fromEntries(
  ALLOWED_TAGS.map((tag) => [tag, true]),
);
/** Elementos vazios: um só já é um grupo balanceado. */
const VOID: Readonly<Record<string, true>> = { br: true, hr: true, img: true };
const TAG = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/;
/** Uma tag de ABERTURA em algum lugar do bloco (um bloco só com `</details>` fica cru). */
const OPEN_TAG = /<[A-Za-z]/;
/** Os 5 tipos da leitura binária (o provider confere os bytes; mesma regra de `images/element.ts`). */
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg)$/i;
/** Altura estimada de uma linha da fonte até o DOM real ser medido. */
const ESTIMATED_LINE_PX = 26;

/** Trecho `[from, to)` de tags em linha balanceadas (abre…fecha, ou um elemento vazio sozinho). */
export interface HtmlGroup {
  readonly from: number;
  readonly to: number;
}

/**
 * Grupos balanceados entre os filhos DIRETOS `HTMLTag` de um contêiner em linha (parágrafo,
 * título, ênfase…): pilha por nome; elemento fora da lista da política, fechamento trocado ou
 * abertura sem fechamento → o grupo inteiro fica cru (R-I10.2). Compartilhado com a exportação
 * (`export/html.ts`) para editor e arquivo mostrarem o mesmo (JEV D-R7-S10-02).
 */
export function inlineHtmlGroups(
  parent: SyntaxNode,
  read: (from: number, to: number) => string,
): HtmlGroup[] {
  const groups: HtmlGroup[] = [];
  const stack: string[] = [];
  let start = 0;
  let valid = true;
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'HTMLTag') continue;
    const match = TAG.exec(read(child.from, child.to));
    if (!match) continue;
    const closing = match[1] === '/';
    const name = (match[2] ?? '').toLowerCase();
    const allowed = ALLOWED[name] === true;
    if (stack.length === 0) {
      if (closing || !allowed) continue;
      if (VOID[name] === true) {
        groups.push({ from: child.from, to: child.to });
        continue;
      }
      stack.push(name);
      start = child.from;
      valid = true;
      continue;
    }
    if (!allowed) valid = false;
    if (!closing) {
      if (VOID[name] !== true) stack.push(name);
      continue;
    }
    if (stack[stack.length - 1] !== name) {
      stack.length = 0;
      continue;
    }
    stack.pop();
    if (stack.length === 0 && valid) groups.push({ from: start, to: child.to });
  }
  return groups;
}

let sanitizeCache: SanitizeCache | null = null;

/** Cache do editor (uma por janela; criada no primeiro desenho, onde já há `window`). */
function sanitized(html: string): DocumentFragment {
  if (sanitizeCache === null) {
    const sanitizer = createHtmlSanitizer(window);
    sanitizeCache = new SanitizeCache(sanitizer.toFragment);
  }
  return sanitizeCache.get(html);
}

/** Destino de cada link renderizado (Mod-clique e Enter abrem pelo serviço de links). */
const linkTargets = new WeakMap<Element, LinkTarget>();
/** Imagens do vault desenhadas dentro de um widget (o `destroy` cancela as assinaturas). */
const embeddedImages = new WeakMap<HTMLElement, Array<[ImageWidget, HTMLElement]>>();
/** Eventos que o próprio widget já tratou (o `ignoreEvent` os tira do CodeMirror). */
const handled = new WeakSet<Event>();

/** Mesma regra de `links/gesture.ts`: modificador principal da plataforma, sem Alt. */
function hasMod(event: MouseEvent, view: EditorView): boolean {
  const mod =
    view.state.facet(appPlatformFacet) === 'mac'
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
  return mod && !event.altKey;
}

function imageSpec(img: Element, raw: string, notePath: string | null): ImageSpec {
  let shown = raw;
  try {
    shown = decodeURIComponent(raw);
  } catch {
    // Escape inválido: mostra como escrito.
  }
  const base = { shown, alt: img.getAttribute('alt') ?? '', title: img.getAttribute('title') };
  const resolved = resolveVaultPath(raw.trim(), notePath);
  if (!resolved.ok)
    return {
      ...base,
      owner: notePath,
      path: null,
      error: resolved.reason === 'outside' ? 'outside' : 'not-found',
    };
  return {
    ...base,
    owner: notePath,
    path: resolved.path,
    error: IMAGE_EXT.test(resolved.path) ? null : 'bad-type',
  };
}

/**
 * Lista FECHADA de transformações do editor (DA-R7-18), sobre o fragmento ainda inerte: `<a href>`
 * → `span.cm-md-link[role=link]` SEM `href` (A-33, 0 navegação); `<a>` sem `href` → `span`;
 * `<mark>`/`<kbd>` → classes `cm-md-mark`/`cm-md-kbd` (as únicas classes postas no conteúdo, depois
 * da sanitização); `<summary>` → `tabindex=-1`; `<img>` sem `src` do vault → o `alt` em `muted`.
 */
function toEditorDom(fragment: DocumentFragment, notePath: string | null): void {
  const doc = fragment.ownerDocument;
  for (const anchor of fragment.querySelectorAll('a')) {
    const span = doc.createElement('span');
    for (const { name, value } of anchor.attributes) {
      if (name !== 'href') span.setAttribute(name, value);
    }
    span.append(...anchor.childNodes);
    const href = anchor.getAttribute('href');
    if (href !== null) {
      const target = classifyHref(href.trim(), notePath);
      span.classList.add('cm-md-link');
      span.setAttribute('role', 'link');
      span.setAttribute('tabindex', '-1');
      span.setAttribute(
        'aria-label',
        linkAccessibleName((span.textContent ?? '').trim(), target, href),
      );
      span.setAttribute('data-href', targetLabel(target, href));
      linkTargets.set(span, target);
    }
    anchor.replaceWith(span);
  }
  for (const mark of fragment.querySelectorAll('mark')) mark.classList.add('cm-md-mark');
  for (const kbd of fragment.querySelectorAll('kbd')) kbd.classList.add('cm-md-kbd');
  for (const summary of fragment.querySelectorAll('summary'))
    summary.setAttribute('tabindex', '-1');
  for (const img of fragment.querySelectorAll('img')) {
    if (img.hasAttribute(IMAGE_SOURCE_ATTR)) continue;
    const alt = img.getAttribute('alt') ?? '';
    if (alt === '') {
      img.remove();
      continue;
    }
    const span = doc.createElement('span');
    span.setAttribute('data-smd-alt', '');
    span.textContent = alt;
    img.replaceWith(span);
  }
}

/** Alvos de foco dentro do widget (ordem do documento). */
function focusables(dom: HTMLElement): HTMLElement[] {
  return [...dom.querySelectorAll<HTMLElement>('summary, .cm-md-link')];
}

/**
 * Widget do HTML sanitizado (W4). `eq` pelo texto e pela nota: o DOM é reaproveitado enquanto o
 * bloco não muda (NFR-41); a sanitização só roda no `toDOM` (só o que está desenhado) e pela cache.
 */
export class HtmlWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly notePath: string | null,
    readonly block: boolean,
  ) {
    super();
  }

  override eq(other: HtmlWidget): boolean {
    return (
      other.source === this.source && other.notePath === this.notePath && other.block === this.block
    );
  }

  override get estimatedHeight(): number {
    if (!this.block) return -1;
    let lines = 1;
    for (let i = this.source.indexOf('\n'); i >= 0; i = this.source.indexOf('\n', i + 1)) lines++;
    return lines * ESTIMATED_LINE_PX;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom: HTMLElement = document.createElement(this.block ? 'div' : 'span');
    dom.className = this.block ? 'cm-md-html' : 'cm-md-html-inline';
    dom.dataset.testid = this.block ? 'html-widget' : 'html-inline';
    const fragment = sanitized(this.source);
    toEditorDom(fragment, this.notePath);
    if (!hasVisibleContent(fragment) && this.block) {
      const empty = dom.appendChild(document.createElement('div'));
      empty.className = 'cm-md-html-empty';
      empty.textContent = EMPTY_HTML_TEXT;
      return dom;
    }
    // Adoção no documento do editor só agora, depois da política e das transformações; nenhum
    // `<img>` tem `src` neste ponto (as do vault passam pelo pipeline de imagens de S1).
    dom.append(fragment);
    const images: Array<[ImageWidget, HTMLElement]> = [];
    for (const img of dom.querySelectorAll(`img[${IMAGE_SOURCE_ATTR}]`)) {
      const spec = imageSpec(img, img.getAttribute(IMAGE_SOURCE_ATTR) ?? '', this.notePath);
      const widget = new ImageWidget(spec, false);
      const shown = widget.toDOM(view);
      img.replaceWith(shown);
      images.push([widget, shown]);
    }
    if (images.length > 0) embeddedImages.set(dom, images);
    // `<details>` abre/fecha só na vista (0 bytes): a altura muda, o CM mede de novo.
    dom.addEventListener('toggle', () => view.requestMeasure(), true);
    dom.addEventListener('mousedown', (event) => this.#modClick(event, view));
    dom.addEventListener('keydown', (event) => this.#key(event, dom, view));
    return dom;
  }

  override destroy(dom: HTMLElement): void {
    for (const [widget, shown] of embeddedImages.get(dom) ?? []) widget.destroy(shown);
    embeddedImages.delete(dom);
  }

  /**
   * O CM recebe só o `mousedown` comum (clique → cursor na fonte → cru). Ficam com o widget: o
   * `<summary>` (abre/fecha sem mexer no cursor), o Mod-clique num link (abre pelo serviço) e as
   * teclas com o foco dentro (depois de "Interagir").
   */
  override ignoreEvent(event: Event): boolean {
    if (handled.has(event)) return true;
    if ((event.target as Element | null)?.closest?.('summary')) return true;
    return event.type !== 'mousedown';
  }

  #modClick(event: MouseEvent, view: EditorView): void {
    if (event.button !== 0 || !hasMod(event, view)) return;
    const span = (event.target as Element | null)?.closest?.('.cm-md-link');
    const target = span ? linkTargets.get(span) : undefined;
    const opener = view.state.facet(linkOpenerFacet);
    if (!target || !opener) return;
    event.preventDefault();
    handled.add(event);
    opener.open(target, view);
  }

  /**
   * Teclado dentro do widget (UX-R7-D5, HTM-DETAILS-KEY): setas/Home/End percorrem summary e links;
   * Enter/Espaço no summary abre/fecha; Enter num link abre; Esc/Shift-Tab → início do bloco no
   * editor; Tab → depois do bloco. Nada fica preso (WCAG 2.1.2).
   */
  #key(event: KeyboardEvent, dom: HTMLElement, view: EditorView): void {
    const items = focusables(dom);
    const active = document.activeElement as HTMLElement | null;
    const index = active ? items.indexOf(active) : -1;
    const focusAt = (i: number) => items[Math.max(0, Math.min(items.length - 1, i))]?.focus();
    const back = (after: boolean) => {
      const from = view.posAtDOM(dom);
      const anchor = after ? Math.min(from + this.source.length + 1, view.state.doc.length) : from;
      view.focus();
      view.dispatch({ selection: { anchor } });
    };
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        focusAt(index + 1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        focusAt(index - 1);
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(items.length - 1);
        break;
      case 'Enter':
      case ' ': {
        if (active?.localName === 'summary') {
          const details = active.parentElement;
          if (details instanceof HTMLDetailsElement) details.open = !details.open;
        } else if (event.key === 'Enter' && active) {
          const target = linkTargets.get(active);
          const opener = view.state.facet(linkOpenerFacet);
          if (target && opener) opener.open(target, view);
        } else return;
        break;
      }
      case 'Escape':
        back(false);
        break;
      case 'Tab':
        back(!event.shiftKey);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    handled.add(event);
  }
}

/** Contêineres em linha já agrupados nesta passada (um parágrafo visita várias `HTMLTag`). */
const grouped = new WeakMap<DecorationContext, Set<string>>();

/**
 * Tags em linha balanceadas (R-I10.2): ao entrar na primeira `HTMLTag` de um contêiner, agrupa
 * todas as irmãs; cada grupo fora do cursor vira um widget em linha sem moldura.
 */
export const htmlInline: InlineContributor = {
  nodes: ['HTMLTag'],
  enter(node, ctx) {
    const parent = node.parent;
    if (!parent) return;
    let seen = grouped.get(ctx);
    if (!seen) grouped.set(ctx, (seen = new Set()));
    const key = `${parent.type.id}@${parent.from}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (const group of inlineHtmlGroups(parent, (from, to) => ctx.doc.sliceString(from, to))) {
      if (ctx.isTouched(group.from, group.to)) continue;
      const widget = new HtmlWidget(ctx.doc.sliceString(group.from, group.to), ctx.notePath, false);
      ctx.out.push(Decoration.replace({ widget }).range(group.from, group.to));
    }
  },
};

/**
 * Bloco HTML de topo (R-I10.2; contribuidor do campo de blocos, §5.2): fora do cursor, o widget
 * sobre as linhas do bloco; tocado (com foco) → cru. Bloco sem nenhuma tag de abertura (só
 * `</details>`, por exemplo) fica cru: não há o que renderizar nem o que foi removido.
 */
export const htmlBlock: BlockContributor = {
  nodes: ['HTMLBlock'],
  build(node, ctx) {
    if (ctx.isTouched(node.from, node.to)) return null;
    const from = ctx.doc.lineAt(node.from).from;
    const to = ctx.doc.lineAt(node.to).to;
    const source = ctx.doc.sliceString(from, to);
    if (!OPEN_TAG.test(source)) return null;
    return Decoration.replace({
      block: true,
      widget: new HtmlWidget(source, ctx.notePath, true),
    }).range(from, to);
  },
};

/** `HTMLBlock` de topo na linha de `pos`. */
function topHtmlBlock(view: EditorView, pos: number): SyntaxNode | null {
  const line = view.state.doc.lineAt(pos);
  for (let node = syntaxTree(view.state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.from > line.to) break;
    if (node.name === 'HTMLBlock' && node.to >= line.from) return node;
  }
  return null;
}

/**
 * "Interagir com o elemento sob o cursor" no W4 (UX-R7-D5, `interactFacet` ordem 30): com o cursor
 * num bloco HTML, o bloco volta a ser widget (o foco sai do texto) e o primeiro summary/link
 * recebe o foco. Sem summary nem link, nada muda e a tecla segue.
 */
export function htmlInteract(): Extension {
  return interactFacet.of({
    order: 30,
    run(view, pos) {
      const node = topHtmlBlock(view, pos);
      if (!node) return false;
      const start = view.state.doc.lineAt(node.from).from;
      const wasFocused = view.state.field(editorFocusField, false) ?? false;
      view.dispatch({ effects: setEditorFocus.of(false) });
      const dom = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-html')].find(
        (el) => view.posAtDOM(el) === start,
      );
      const first = dom ? focusables(dom)[0] : undefined;
      if (!first) {
        view.dispatch({ effects: setEditorFocus.of(wasFocused) });
        return false;
      }
      first.focus();
      return true;
    },
  });
}
