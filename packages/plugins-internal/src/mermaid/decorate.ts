import { syntaxTree } from '@codemirror/language';
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  isTouched,
  pluginFocus,
  pluginFocusField,
  revealOnMouseDown,
  warnGlyph,
} from '../shared/reveal';
import {
  finishSvg,
  mermaidLabel,
  renderMermaid,
  themeVariables,
  type MermaidRender,
} from './render';

/** Debounce da re-renderização depois de uma edição dentro do diagrama (R-7.2, NFR-22). */
export const MERMAID_DEBOUNCE_MS = 300;
const CACHE_MAX = 100;

export interface MermaidBlock {
  /** Início da linha da cerca de abertura e fim da linha da cerca de fechamento. */
  readonly from: number;
  readonly to: number;
  readonly source: string;
}

/**
 * Cache por `assinatura do tema + fonte` (arch-frontend r2 §7.3): trocar de tema renderiza de novo;
 * voltar ao tema anterior usa o cache. `latest` guarda o último render de cada fonte, mostrado
 * enquanto o render do tema novo não chega (sem voltar à fonte crua numa troca de tema).
 */
const cache = new Map<string, MermaidRender>();
const latest = new Map<string, MermaidRender>();

const cacheKey = (theme: string, source: string) => `${theme}\u0000${source}`;

function remember(theme: string, source: string, render: MermaidRender): void {
  cache.set(cacheKey(theme, source), render);
  latest.delete(source);
  latest.set(source, render);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  if (latest.size > CACHE_MAX) latest.delete(latest.keys().next().value as string);
}

/** Uma renderização terminou: o campo recalcula. */
export const mermaidReady = StateEffect.define<null>();
/** As variáveis de tema (valores calculados) mudaram; o valor é a assinatura delas. */
export const mermaidTheme = StateEffect.define<string>();

/** Diagrama renderizado (MMD-OK): `.cm-mermaid` com o SVG; nunca rola (DESIGN §8.18). */
class MermaidWidget extends WidgetType {
  static instances = 0;

  constructor(
    readonly render: Extract<MermaidRender, { ok: true }>,
    readonly label: string,
  ) {
    super();
  }

  override eq(other: MermaidWidget): boolean {
    return other.render === this.render && other.label === this.label;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = view.dom.ownerDocument.createElement('div');
    el.className = 'cm-mermaid';
    const unique = `${this.render.id}-w${++MermaidWidget.instances}`;
    el.innerHTML = this.render.svg.split(this.render.id).join(unique);
    const svg = el.querySelector('svg');
    if (svg) finishSvg(svg, this.label);
    return el;
  }

  override get estimatedHeight(): number {
    const viewBox = /viewBox="[-\d.]+ [-\d.]+ [\d.]+ ([\d.]+)"/.exec(this.render.svg);
    return viewBox ? Math.min(Number(viewBox[1]), 2000) : -1;
  }

  override ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown';
  }
}

/** Fonte inválida (MMD-ERROR): forma de alerta em linha, "Diagrama inválido: <mensagem>". */
class MermaidErrorWidget extends WidgetType {
  constructor(readonly message: string) {
    super();
  }

  override eq(other: MermaidErrorWidget): boolean {
    return other.message === this.message;
  }

  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const el = doc.createElement('div');
    el.className = 'cm-mermaid-error';
    el.dataset.testid = 'mermaid-error';
    el.appendChild(warnGlyph(doc));
    const text = el.appendChild(doc.createElement('span'));
    text.textContent = `Diagrama inválido: ${this.message}`;
    return el;
  }

  override ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown';
  }
}

/** Cercas ```mermaid de topo, fechadas (uma cerca sem fechamento fica crua). */
export function mermaidBlocks(state: EditorState): MermaidBlock[] {
  const doc = state.doc;
  const out: MermaidBlock[] = [];
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== 'FencedCode') continue;
    const info = node.getChild('CodeInfo');
    if (!info || doc.sliceString(info.from, info.to).trim().split(/\s/)[0] !== 'mermaid') continue;
    if (node.getChildren('CodeMark').length < 2) continue;
    const text = node.getChild('CodeText');
    out.push({
      from: doc.lineAt(node.from).from,
      to: doc.lineAt(node.to).to,
      source: text ? doc.sliceString(text.from, text.to) : '',
    });
  }
  return out;
}

interface MermaidState {
  readonly blocks: readonly MermaidBlock[];
  /** Assinatura das variáveis de tema atuais ('' até o primeiro quadro). */
  readonly theme: string;
  readonly touched: readonly number[];
  readonly decorations: DecorationSet;
}

/** Bloco com render no cache → widget; sem render → fonte crua (UX-R2-D22, MMD-LOADING). */
function decorationsFor(state: Omit<MermaidState, 'decorations'>): DecorationSet {
  const out: Range<Decoration>[] = [];
  state.blocks.forEach((block, i) => {
    if (state.touched.includes(i)) return;
    const render = cache.get(cacheKey(state.theme, block.source)) ?? latest.get(block.source);
    if (!render) return;
    const widget = render.ok
      ? new MermaidWidget(render, mermaidLabel(block.source))
      : new MermaidErrorWidget(render.message);
    out.push(Decoration.replace({ block: true, widget }).range(block.from, block.to));
  });
  return Decoration.set(out);
}

function touchedBlocks(state: EditorState, blocks: readonly MermaidBlock[]): number[] {
  const touched: number[] = [];
  blocks.forEach((block, i) => {
    if (isTouched(state, block.from, block.to)) touched.push(i);
  });
  return touched;
}

function build(state: EditorState, theme: string): MermaidState {
  const blocks = mermaidBlocks(state);
  const base = { blocks, theme, touched: touchedBlocks(state, blocks) };
  return { ...base, decorations: decorationsFor(base) };
}

/**
 * Blocos Mermaid (arch-frontend r2 §7.2): o CodeMirror proíbe decorações de bloco vindas de
 * plugins, então o campo acompanha os blocos de topo (O(blocos) só quando texto/árvore mudam).
 */
export const mermaidField = StateField.define<MermaidState>({
  create: (state) => build(state, ''),
  update(value, tr) {
    let theme = value.theme;
    let ready = false;
    for (const effect of tr.effects) {
      if (effect.is(mermaidTheme)) theme = effect.value;
      else if (effect.is(mermaidReady)) ready = true;
    }
    if (tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state))
      return build(tr.state, theme);
    const focus =
      tr.startState.field(pluginFocusField, false) !== tr.state.field(pluginFocusField, false);
    if (!ready && theme === value.theme && !tr.selection && !focus) return value;
    const touched = touchedBlocks(tr.state, value.blocks);
    const same =
      touched.length === value.touched.length && touched.every((i, n) => value.touched[n] === i);
    if (!ready && theme === value.theme && same) return value;
    const base = { blocks: value.blocks, theme, touched };
    return { ...base, decorations: decorationsFor(base) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

interface ThemeSnapshot {
  readonly vars: Record<string, string>;
  /** Os valores serializados: chave do cache e valor do campo. */
  readonly signature: string;
}

/** Leitura das variáveis do tema no `<html>` (valores calculados; nada transcrito). */
function readTheme(doc: Document): ThemeSnapshot {
  const style = doc.defaultView?.getComputedStyle(doc.documentElement);
  const vars = themeVariables((property) => style?.getPropertyValue(property) ?? '');
  return { vars, signature: JSON.stringify(vars) };
}

/**
 * Companheiro do campo: acompanha o tema, carrega a biblioteca quando um bloco sem render fica
 * visível e renderiza fora das transações (imediato ao aparecer; 300 ms depois da última edição).
 */
const mermaidLoader = ViewPlugin.fromClass(
  class {
    timer: number | undefined = undefined;
    running = false;
    again = false;
    destroyed = false;
    theme: ThemeSnapshot;
    readonly observer: MutationObserver | null;

    constructor(readonly view: EditorView) {
      const doc = view.dom.ownerDocument;
      this.theme = readTheme(doc);
      this.observer =
        typeof MutationObserver === 'undefined'
          ? null
          : new MutationObserver(() => this.syncTheme());
      this.observer?.observe(doc.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'data-theme-base'],
      });
      // Nenhum `dispatch` durante a construção do plugin: o tema entra no campo logo depois.
      queueMicrotask(() => {
        if (this.destroyed) return;
        if (view.state.field(mermaidField).theme !== this.theme.signature)
          view.dispatch({ effects: mermaidTheme.of(this.theme.signature) });
        this.schedule(0);
      });
    }

    update(update: ViewUpdate) {
      if (update.docChanged) this.schedule(MERMAID_DEBOUNCE_MS);
      else if (update.viewportChanged) this.schedule(0);
    }

    syncTheme() {
      const theme = readTheme(this.view.dom.ownerDocument);
      if (theme.signature === this.theme.signature) return;
      this.theme = theme;
      this.view.dispatch({ effects: mermaidTheme.of(theme.signature) });
      this.schedule(0);
    }

    schedule(delay: number) {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.run(), delay);
    }

    pending(signature: string): MermaidBlock[] {
      const { blocks } = this.view.state.field(mermaidField);
      return blocks.filter(
        (block) =>
          !cache.has(cacheKey(signature, block.source)) &&
          this.view.visibleRanges.some((r) => r.from <= block.to && r.to >= block.from),
      );
    }

    async run() {
      if (this.running) {
        this.again = true;
        return;
      }
      this.running = true;
      try {
        do {
          this.again = false;
          const theme = this.theme;
          const pending = this.pending(theme.signature);
          for (const block of pending) {
            const render = await renderMermaid(block.source, theme.vars);
            if (this.destroyed) return;
            remember(theme.signature, block.source, render);
          }
          if (pending.length > 0) this.view.dispatch({ effects: mermaidReady.of(null) });
        } while (this.again && !this.destroyed);
      } catch (error) {
        console.warn('[simplemd] Mermaid não carregou', error);
      } finally {
        this.running = false;
      }
    }

    destroy() {
      this.destroyed = true;
      this.observer?.disconnect();
      window.clearTimeout(this.timer);
    }
  },
);

/** Estilos (DESIGN §8.18 MMD-OK/MMD-ERROR; só `var(--…)`, design-ack T-14). */
const mermaidStyles = EditorView.theme({
  '.cm-mermaid': {
    backgroundColor: 'var(--color-bg)',
    border: '1px solid color-mix(in srgb, var(--color-border) 45%, var(--color-bg))',
    borderRadius: 'var(--dimension-radius)',
    padding: 'var(--dimension-space-3)',
    cursor: 'text',
  },
  '.cm-mermaid svg': { display: 'block', maxWidth: '100%', height: 'auto', marginInline: 'auto' },
  '.cm-mermaid-error': {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--dimension-space-2)',
    backgroundColor: 'var(--color-code-bg)',
    color: 'var(--color-fg)',
    borderInlineStart: '2px solid var(--color-danger)',
    padding: 'var(--dimension-space-2) var(--dimension-space-3)',
    overflowWrap: 'anywhere',
    fontFamily: 'var(--fontFamily-ui)',
    cursor: 'text',
  },
  '.cm-mermaid-error svg': { color: 'var(--color-danger)', flex: 'none', marginTop: '0.2em' },
  '.cm-mermaid-error > svg': { width: '1em', height: '1em' },
});

/** Extensão `source` do Mermaid: campo de blocos, carregador sob demanda, clique revela. */
export const mermaidExtension: Extension = [
  pluginFocus,
  mermaidField,
  mermaidLoader,
  revealOnMouseDown('.cm-mermaid, .cm-mermaid-error'),
  mermaidStyles,
];
