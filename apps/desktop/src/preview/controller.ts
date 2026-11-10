import { EditorView } from '@codemirror/view';
import {
  classifyHref,
  linkOpenerFacet,
  type ExportImages,
  type ExportWikilinks,
  type ImageSource,
} from '@simplemd/core';
import { Observable } from '@simplemd/plugin-api/runtime';
import { lightTokens } from '@simplemd/themes';
import type { PreviewBlocks } from '../export/pipeline';
import type { DocumentRegistry } from '../state/documents';
import type { AppStore } from '../state/store';
import type { Clock } from '../state/sync';

/**
 * Motor da prévia lado a lado (r38a; design-r38 §1, D-R38-01..11): renderiza a nota ATIVA com o
 * serializador e a política do HTML cru da exportação (`previewBody`, `mode: 'print'`) dentro de um
 * host do DOM do app que só este controlador escreve (D-R38-07: o React desenha o host vazio).
 * Nada é gravado; o único `EditorView` só é lido (links, rolagem) e rolado.
 */

/** Espera depois da última mudança (D-R38-09); cresce com o custo da última renderização. */
export const PREVIEW_DEBOUNCE_MS = 300;
/** Teto da espera adaptativa (3× a última renderização). */
export const PREVIEW_MAX_DELAY_MS = 2000;

/** Espera do debounce depois de uma renderização que levou `lastMs` (D-R38-09). */
export function previewDelay(lastMs: number): number {
  return Math.min(PREVIEW_MAX_DELAY_MS, Math.max(PREVIEW_DEBOUNCE_MS, 3 * lastMs));
}

/**
 * Nome da medida `performance` da última renderização inserida (evidência de desempenho): uma
 * entrada por vez, sem o caminho da nota (F6, r38a2).
 */
export const PREVIEW_RENDER_MEASURE = 'simplemd:preview-render';
/** Classe do invólucro de cada bloco de topo; `data-line` = linha da nota em que ele começa. */
export const PREVIEW_BLOCK_CLASS = 'smd-preview-block';
/** Classe do aviso que fica no lugar de um bloco recusado pelo `assertInert` (F3, r38a2). */
export const PREVIEW_REFUSED_CLASS = 'smd-preview-refused';
/** Texto desse aviso. */
export const PREVIEW_REFUSED_TEXT = 'Bloco não exibido na prévia: conteúdo recusado por segurança.';

export type PreviewStatus =
  /** Prévia escondida: nenhum trabalho (nem assinatura de mudança). */
  | { readonly kind: 'off' }
  /** Visível sem nota pronta (sem aba ou aba carregando). */
  | { readonly kind: 'empty' }
  | { readonly kind: 'rendering'; readonly path: string }
  | {
      readonly kind: 'ready';
      readonly path: string;
      /** Contador de renderizações inseridas (e2e/evidência esperam por ele). */
      readonly generation: number;
      readonly ms: number;
    }
  /**
   * `unsafe` = nem a montagem bloco a bloco passou no `assertInert` (nada inserido; um bloco
   * recusado sozinho vira aviso numa prévia `ready`); `failed` = pipeline falhou.
   */
  | { readonly kind: 'error'; readonly path: string; readonly reason: 'unsafe' | 'failed' };

export interface PreviewDeps {
  readonly store: AppStore;
  readonly registry: DocumentRegistry;
  readonly clock: Clock;
  /** Plugin interno ligado? Desligado → o conteúdo dele sai cru, como na exportação. */
  enabled(id: string): boolean;
  /** A cache de imagens da janela (a do editor principal); `null` = imagens como texto. */
  imageSource(): ImageSource | null;
  wikilinks(notePath: string): ExportWikilinks;
  /**
   * O editor do grupo com foco (r39b): links pelo serviço único e rolagem sincronizada só com ele.
   */
  view(): EditorView | null;
  /**
   * Avisa quando `view` pode ter mudado (r39c: montagem/desmontagem de um view, troca do grupo com
   * foco; o `onApplied` do montador). Devolve o cancelamento.
   */
  onViewChange(listener: () => void): () => void;
  /** Valores atuais dos tokens do tema (Mermaid); padrão: lidos do `<html>`. */
  tokens?(): Readonly<Record<string, string>>;
}

/** Ponto de uma âncora: linha da nota × deslocamento vertical na prévia (px). */
export interface PreviewAnchor {
  readonly line: number;
  readonly top: number;
}

class PreviewStatusStore extends Observable<PreviewStatus> {
  constructor() {
    super({ kind: 'off' });
  }

  set(next: PreviewStatus): void {
    this.publish(next);
  }
}

const loadPipeline = () => import('../export/pipeline');
const loadImages = () => import('../export/images');
const loadNormalize = () => import('../export/normalize');

/** `src` que a prévia aceita fora da lista de esquemas: só as `blob:` da cache desta renderização. */
const BLOB_URL = /^blob:[^\s"'<>&]+$/;

/**
 * `assertInert` (D-R38-04): a última conferência antes de o HTML entrar no DOM do app. As `blob:`
 * das imagens do vault viram marcas relativas com um nonce, o todo passa pelo MESMO pós-checagem DOM
 * da exportação (`normalize`: parser do navegador, elementos bloqueados, `on*`, esquemas de URL,
 * CSS que busca algo ou sai do diagrama e releitura estável contra mXSS) e as marcas voltam.
 * Qualquer recusa → `null` ({@link inertBlocks} decide o que fica de fora). Uma `blob:` fora do
 * mapa não vira marca e é recusada.
 */
export function assertInert(
  html: string,
  blobs: Iterable<string>,
  normalize: (html: string) => string | null,
): string | null {
  const nonce = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) =>
    n.toString(16).padStart(8, '0'),
  ).join('');
  const allowed = [...new Set(blobs)].filter((url) => BLOB_URL.test(url));
  let marked = html;
  allowed.forEach((url, index) => {
    marked = marked.split(`src="${url}"`).join(`src="#smd-pv-${nonce}-${index}"`);
  });
  const checked = normalize(marked);
  if (checked === null) return null;
  return checked.replace(
    new RegExp(`#smd-pv-${nonce}-(\\d+)`, 'g'),
    (_, index: string) => allowed[Number(index)] ?? '',
  );
}

/**
 * Saída do `assertInert` do HTML de cada bloco de topo (sem o invólucro, que só muda a linha) na
 * última renderização que conferiu bloco a bloco (R38B-CACHE-BLOCO): `null` = recusado. Bloco com
 * `blob:` não entra (a conferência dele depende das imagens desta renderização).
 */
export type BlockVerdicts = Map<string, string | null>;

/**
 * `assertInert` por bloco de topo (F3, r38a2): o corpo inteiro passa numa conferência só (o caso
 * comum, o mesmo custo de antes); recusado, cada bloco é conferido sozinho e só o recusado vira o
 * aviso {@link PREVIEW_REFUSED_TEXT}, com a mesma linha (as âncoras da rolagem ficam). O que foi
 * montado passa de novo inteiro; `null` só se nem assim passar (nada é inserido).
 *
 * R38B-CACHE-BLOCO: com `verdicts` (a memória da renderização anterior), um bloco já conferido não
 * é conferido de novo, e com um bloco **desta** renderização recusado na memória a conferência do
 * corpo inteiro (que falharia) é pulada: o bloco recusado custa uma conferência só, na renderização
 * em que aparece. Uma recusa que não está mais nos blocos (outra nota, bloco apagado) não pula
 * nada: o corpo limpo segue numa conferência só (NB-1 do code-review r41b-ui).
 */
export function inertBlocks(
  blocks: PreviewBlocks,
  blobs: readonly string[],
  normalize: (html: string) => string | null,
  verdicts: BlockVerdicts = new Map(),
): string | null {
  const wrap = (line: number, html: string) =>
    `<div class="${PREVIEW_BLOCK_CLASS}" data-line="${line}">${html}</div>`;
  const joined = () => blocks.map((block) => wrap(block.line, block.html)).join('\n');
  if (!blocks.some((block) => verdicts.get(block.html) === null)) {
    const whole = assertInert(joined(), blobs, normalize);
    if (whole !== null) {
      verdicts.clear();
      return whole;
    }
  }
  const refused = `<p class="${PREVIEW_REFUSED_CLASS}">${PREVIEW_REFUSED_TEXT}</p>`;
  const seen: BlockVerdicts = new Map();
  let anyRefused = false;
  const each = blocks.map((block) => {
    const memo = !block.html.includes('blob:');
    const checked =
      memo && verdicts.has(block.html)
        ? (verdicts.get(block.html) ?? null)
        : assertInert(block.html, blobs, normalize);
    if (memo) seen.set(block.html, checked);
    if (checked === null) anyRefused = true;
    return wrap(block.line, checked ?? refused);
  });
  verdicts.clear();
  for (const [html, checked] of seen) verdicts.set(html, checked);
  // Sem recusa nesta renderização, a montagem é a mesma do caso comum.
  return assertInert(anyRefused ? each.join('\n') : joined(), blobs, normalize);
}

/**
 * Mapa linear por trechos entre âncoras ordenadas (`from` não decrescente): o valor `to` que
 * corresponde a `x`. Fora das pontas, a ponta mais próxima; trecho de largura 0 → o início dele.
 */
function piecewise(
  anchors: readonly PreviewAnchor[],
  x: number,
  from: keyof PreviewAnchor,
  to: keyof PreviewAnchor,
): number {
  const first = anchors[0];
  if (!first) return 0;
  if (x <= first[from]) return first[to];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1] as PreviewAnchor;
    const b = anchors[i] as PreviewAnchor;
    if (x > b[from]) continue;
    const span = b[from] - a[from];
    return span <= 0 ? a[to] : a[to] + ((x - a[from]) / span) * (b[to] - a[to]);
  }
  return (anchors[anchors.length - 1] as PreviewAnchor)[to];
}

/** Linha (fracionária) da nota → deslocamento na prévia (D-R38-08). */
export function lineToOffset(anchors: readonly PreviewAnchor[], line: number): number {
  return piecewise(anchors, line, 'line', 'top');
}

/** Deslocamento na prévia → linha (fracionária) da nota. */
export function offsetToLine(anchors: readonly PreviewAnchor[], top: number): number {
  return piecewise(anchors, top, 'top', 'line');
}

/** Tokens do tema aplicados no `<html>` (o `applyTheme` grava as propriedades lá). */
function documentTokens(): Readonly<Record<string, string>> {
  if (typeof document === 'undefined') return lightTokens;
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    Object.entries(lightTokens).map(([name, fallback]) => [
      name,
      style.getPropertyValue(name).trim() || fallback,
    ]),
  );
}

const frame = (callback: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
  else setTimeout(callback, 16);
};

type Leader = 'editor' | 'preview' | null;
const GESTURES = ['wheel', 'pointerdown', 'keydown', 'focusin'] as const;

export class PreviewController {
  readonly status = new PreviewStatusStore();
  readonly #deps: PreviewDeps;
  #host: HTMLElement | null = null;
  #visible = false;
  #timer: unknown = null;
  /** Pedidos de renderização: o resultado de um pedido mais velho é descartado. */
  #request = 0;
  /** Renderizações inseridas. */
  #generation = 0;
  #lastMs = 0;
  #release: () => void = () => {};
  #path: string | null = null;
  #leader: Leader = null;
  #syncQueued = false;
  #boundView: EditorView | null = null;
  #unbind: Array<() => void> = [];
  #unbindView: Array<() => void> = [];
  /** Assinaturas do construtor (store, registro, view com foco); soltas no `dispose`. */
  readonly #subscriptions: Array<() => void> = [];
  /** Conferência por bloco da última renderização que precisou dela (R38B-CACHE-BLOCO). */
  readonly #verdicts: BlockVerdicts = new Map();

  constructor(deps: PreviewDeps) {
    this.#deps = deps;
    const { store, registry } = deps;
    const initial = store.getState();
    let { activeId, themeId, prefs } = initial;
    let docStatus = activeId === null ? undefined : initial.docs[activeId];
    this.#subscriptions.push(
      store.subscribe((state) => {
        const status = state.activeId === null ? undefined : state.docs[state.activeId];
        // Gravar (`dirty → saving → clean`) não muda o texto: da aba ativa, só a carga (`loading` →
        // pronta) pede renderização (F4, r38a2); recarga e conflito resolvido vêm pelo `onReplace`.
        const changed =
          state.activeId !== activeId ||
          (status === 'loading') !== (docStatus === 'loading') ||
          state.themeId !== themeId ||
          state.prefs !== prefs;
        activeId = state.activeId;
        docStatus = status;
        themeId = state.themeId;
        prefs = state.prefs;
        if (changed) this.#schedule(0);
      }),
      // Recarga do disco ou resolução de conflito na aba ativa (o editor não emite mudança).
      registry.onReplace((id) => {
        if (id === deps.store.getState().activeId) this.#schedule(0);
      }),
      // r39c: o view com foco mudou e mostra a nota da prévia (juntar com `keep` = o grupo da
      // direita não muda a nota ativa, então nada renderiza de novo): a rolagem passa a ele já. Com
      // outra nota, a renderização dela liga o view.
      deps.onViewChange(() => {
        if (this.#visible && this.#path !== null && this.#path === store.getState().activeId)
          this.#bindView();
      }),
    );
  }

  /**
   * Encerra o controlador (R39C-ANUNCIOS, NB-5): solta as assinaturas do construtor, os ouvintes do
   * host e do view, a espera do debounce e as imagens da nota mostrada. Depois disso nada renderiza.
   * No app, a vida dele é a da janela; quem cria um controlador mais curto (os testes) encerra aqui.
   */
  dispose(): void {
    for (const off of this.#subscriptions.splice(0)) off();
    this.setVisible(false);
    this.attach(null);
  }

  /**
   * Host da prévia (a UI passa o elemento rolável vazio; `null` ao desmontar). O conteúdo é só
   * deste controlador: cliques em links nunca navegam a webview (D-R38-11).
   */
  attach(el: HTMLElement | null): void {
    if (el === this.#host) return;
    for (const off of this.#unbind.splice(0)) off();
    this.#host = el;
    if (!el) return;
    const onClick = (event: MouseEvent) => this.#onLink(event);
    const onGesture = () => {
      this.#leader = 'preview';
    };
    const onScroll = () => {
      if (this.#leader === 'preview') this.#queueSync('editor');
    };
    el.addEventListener('click', onClick);
    el.addEventListener('auxclick', onClick);
    el.addEventListener('scroll', onScroll, { passive: true });
    for (const name of GESTURES) el.addEventListener(name, onGesture, { passive: true });
    this.#unbind.push(() => {
      el.removeEventListener('click', onClick);
      el.removeEventListener('auxclick', onClick);
      el.removeEventListener('scroll', onScroll);
      for (const name of GESTURES) el.removeEventListener(name, onGesture);
    });
    if (this.#visible) this.#schedule(0);
  }

  /** Mostrada (aba aberta + `layout.preview.open` + cabe) ou escondida (0 trabalho, host vazio). */
  setVisible(on: boolean): void {
    if (on === this.#visible) return;
    this.#visible = on;
    if (on) {
      this.#schedule(0);
      return;
    }
    this.#cancel();
    this.#clear();
    for (const off of this.#unbindView.splice(0)) off();
    this.#boundView = null;
    this.status.set({ kind: 'off' });
  }

  /**
   * Cada mudança do documento no editor (a UI chama depois de `sync.onEditorChange`, que atualiza o
   * registro): debounce adaptativo; o texto é lido do registro na hora de renderizar.
   */
  onEditorChange(path: string): void {
    if (!this.#visible || path !== this.#deps.store.getState().activeId) return;
    this.#schedule(previewDelay(this.#lastMs));
  }

  #cancel(): void {
    if (this.#timer !== null) this.#deps.clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#request++;
  }

  #schedule(ms: number): void {
    if (!this.#visible) return;
    if (this.#timer !== null) this.#deps.clock.clearTimeout(this.#timer);
    this.#timer = this.#deps.clock.setTimeout(() => {
      this.#timer = null;
      void this.#render();
    }, ms);
  }

  /** Host vazio, nenhuma nota mostrada (e as imagens dela soltas na cache). */
  #clear(): void {
    this.#host?.replaceChildren();
    this.#release();
    this.#release = () => {};
    this.#path = null;
    this.#verdicts.clear();
  }

  async #render(): Promise<void> {
    const request = ++this.#request;
    const host = this.#host;
    const { store, registry } = this.#deps;
    const path = store.getState().activeId;
    const record = path === null ? undefined : registry.get(path);
    if (!host || path === null || !record) {
      this.#clear();
      this.status.set({ kind: 'empty' });
      return;
    }
    this.status.set({ kind: 'rendering', path });
    const doc = record.state.doc.toString();
    const started = performance.now();
    let release: () => void = () => {};
    try {
      const [{ previewBody }, { printImages }, { normalizeRender }] = await Promise.all([
        loadPipeline(),
        loadImages(),
        loadNormalize(),
      ]);
      if (request !== this.#request) return;
      const printed = await printImages(doc, path, this.#deps.imageSource(), () =>
        this.#schedule(previewDelay(this.#lastMs)),
      );
      release = printed.release;
      if (request !== this.#request) return release();
      const blocks = await previewBody(
        doc,
        (id) => this.#deps.enabled(id),
        printed.images,
        (this.#deps.tokens ?? documentTokens)(),
        this.#deps.wikilinks(path),
      );
      if (request !== this.#request) return release();
      const safe = inertBlocks(
        blocks,
        blobSources(printed.images),
        normalizeRender,
        this.#verdicts,
      );
      if (safe === null) {
        release();
        this.#clear();
        this.status.set({ kind: 'error', path, reason: 'unsafe' });
        return;
      }
      // Documento inerte (nada carrega nem executa ali); só então os nós entram no host.
      const parsed = new DOMParser().parseFromString(`<body>${safe}</body>`, 'text/html');
      const keep = this.#path === path ? this.#previewLine() : null;
      host.replaceChildren(...parsed.body.childNodes);
      this.#release();
      this.#release = release;
      this.#path = path;
      this.#generation++;
      const ms = performance.now() - started;
      this.#lastMs = ms;
      measure(started, ms);
      this.status.set({ kind: 'ready', path, generation: this.#generation, ms });
      this.#bindView();
      if (keep !== null && this.#leader === 'preview') this.#scrollPreviewTo(keep);
      else this.#syncPreview();
    } catch {
      release();
      if (request !== this.#request) return;
      // A falha não deixa a nota anterior no host com o erro desta (F5, r38a2); a mesma nota fica.
      if (this.#path !== path) this.#clear();
      this.status.set({ kind: 'error', path, reason: 'failed' });
    }
  }

  /** Clique em link da prévia: nunca navega; o serviço único abre (nota, wikilink, URL externa). */
  #onLink(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target.closest('a') : null;
    if (!target || !this.#host?.contains(target)) return;
    event.preventDefault();
    if (event.type !== 'click' || event.button !== 0) return;
    const href = target.getAttribute('href');
    const view = this.#deps.view();
    const opener = view?.state.facet(linkOpenerFacet) ?? null;
    if (href === null || !view || !opener) return;
    opener.open(classifyHref(href, this.#path), view);
  }

  /**
   * Liga os gestos e a rolagem do editor (o líder é o último painel com gesto, D-R38-08). r39b: só
   * o view do grupo com foco move a prévia; o de outro grupo é ignorado até a renderização da nota
   * do grupo novo ligar o view dele. r39c: com a mesma nota, a troca do view (`onViewChange`) liga.
   */
  #bindView(): void {
    const view = this.#deps.view();
    if (view === this.#boundView) return;
    for (const off of this.#unbindView.splice(0)) off();
    this.#boundView = view;
    if (!view) return;
    const onGesture = () => {
      if (this.#deps.view() === view) this.#leader = 'editor';
    };
    const onScroll = () => {
      if (this.#leader === 'editor' && this.#deps.view() === view) this.#queueSync('preview');
    };
    for (const name of GESTURES) view.dom.addEventListener(name, onGesture, { passive: true });
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    this.#unbindView.push(() => {
      for (const name of GESTURES) view.dom.removeEventListener(name, onGesture);
      view.scrollDOM.removeEventListener('scroll', onScroll);
    });
  }

  #queueSync(follower: 'editor' | 'preview'): void {
    if (this.#syncQueued) return;
    this.#syncQueued = true;
    frame(() => {
      this.#syncQueued = false;
      if (follower === 'preview') this.#syncPreview();
      else this.#syncEditor();
    });
  }

  /** Âncoras da prévia: início (linha 1, topo 0), cada bloco de topo e o fim do documento. */
  #anchors(): PreviewAnchor[] {
    const host = this.#host;
    const view = this.#deps.view();
    if (!host) return [];
    const base = host.getBoundingClientRect().top - host.scrollTop;
    const anchors: PreviewAnchor[] = [{ line: 1, top: 0 }];
    for (const block of host.querySelectorAll<HTMLElement>(`:scope > .${PREVIEW_BLOCK_CLASS}`)) {
      const line = Number(block.dataset.line);
      const last = anchors[anchors.length - 1] as PreviewAnchor;
      if (!Number.isFinite(line) || line <= last.line) continue;
      anchors.push({ line, top: Math.max(last.top, block.getBoundingClientRect().top - base) });
    }
    const lines = view ? view.state.doc.lines + 1 : (anchors[anchors.length - 1]?.line ?? 1) + 1;
    anchors.push({ line: lines, top: Math.max(host.scrollHeight - host.clientHeight, 0) });
    return anchors;
  }

  /** Linha (fracionária) no topo visível do editor. */
  #editorLine(view: EditorView): number {
    const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
    const block = view.lineBlockAtHeight(Math.max(height, 0));
    const line = view.state.doc.lineAt(block.from).number;
    return line + (block.height > 0 ? Math.max(height - block.top, 0) / block.height : 0);
  }

  #previewLine(): number | null {
    const host = this.#host;
    return host ? offsetToLine(this.#anchors(), host.scrollTop) : null;
  }

  #scrollPreviewTo(line: number): void {
    if (this.#host) this.#host.scrollTop = lineToOffset(this.#anchors(), line);
  }

  /** Prévia segue o editor. */
  #syncPreview(): void {
    const view = this.#deps.view();
    if (!view || !this.#host || this.#path === null) return;
    this.#scrollPreviewTo(this.#editorLine(view));
  }

  /** Editor segue a prévia: só rola (sem seleção, sem mudança no documento). */
  #syncEditor(): void {
    const view = this.#deps.view();
    const line = this.#previewLine();
    if (!view || line === null) return;
    const number = Math.min(Math.max(Math.floor(line), 1), view.state.doc.lines);
    view.dispatch({
      effects: EditorView.scrollIntoView(view.state.doc.line(number).from, { y: 'start' }),
    });
  }
}

/** As `blob:` que o mapa desta renderização entregou (as únicas aceitas no `src`). */
function blobSources(images: ExportImages): string[] {
  const out: string[] = [];
  for (const image of images.map.values()) if ('src' in image) out.push(image.src);
  return out;
}

/**
 * Medida `performance` da renderização (só evidência; falha do navegador não importa). A anterior
 * sai antes e nada da nota vai junto: a linha do tempo não guarda caminhos (F6, r38a2).
 */
function measure(start: number, ms: number): void {
  try {
    performance.clearMeasures(PREVIEW_RENDER_MEASURE);
    performance.measure(PREVIEW_RENDER_MEASURE, { start, end: start + ms });
  } catch {
    // Sem a API de medida com opções: nada a registrar.
  }
}
