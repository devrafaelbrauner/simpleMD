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
  focusChanged,
  isTouched,
  pluginFocus,
  pluginFocusField,
  revealOnMouseDown,
} from '../shared/reveal';
import { blockedSpans, blockMathIn, inlineMathIn, type MathSpan } from '../shared/scan';
import { cachedMath, loadedKatex, loadKatex, renderMath, type MathRender } from './render';

/** A biblioteca carregou ou fórmulas novas entraram no cache: recalcular as decorações. */
export const mathReady = StateEffect.define<null>();

/** Fórmula renderizada (KTX-OK): HTML do KaTeX, com MathML para a tecnologia assistiva. */
export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly html: string,
    readonly display: boolean,
  ) {
    super();
  }

  override eq(other: MathWidget): boolean {
    return other.html === this.html && other.display === this.display;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = view.dom.ownerDocument.createElement(this.display ? 'div' : 'span');
    el.className = this.display ? 'cm-math-block' : 'cm-math';
    // Saída do KaTeX com `trust: false` (texto do documento escapado pela biblioteca).
    el.innerHTML = this.html;
    return el;
  }

  override ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown';
  }
}

/**
 * Descrição do erro para a tecnologia assistiva (UX-R2-D23, STR-86): texto visualmente oculto, de
 * largura zero, logo depois da fonte crua. Sem `aria-label` num `span` sem papel.
 */
export class MathErrorDescription extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  override eq(other: MathErrorDescription): boolean {
    return other.text === this.text;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement('span');
    span.className = 'cm-math-sr';
    span.contentEditable = 'false';
    span.textContent = this.text;
    return span;
  }
}

const errorText = (render: MathRender) => `Fórmula inválida: ${render.error ?? ''}`;

/** Fonte crua com sublinhado pontilhado `danger` + `title` + descrição oculta (KTX-ERROR). */
function pushError(out: Range<Decoration>[], from: number, to: number, render: MathRender): void {
  const text = errorText(render);
  out.push(
    Decoration.mark({ class: 'cm-math-error', attributes: { title: text } }).range(from, to),
  );
  out.push(Decoration.widget({ widget: new MathErrorDescription(text), side: 1 }).range(to));
}

/**
 * Matemática em linha nas faixas visíveis (R-7.3). Sem a biblioteca carregada, a fonte fica crua
 * (sem placeholder) e `missing` vira `true` para o plugin pedir a carga.
 */
export function computeInlineMath(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): { decorations: DecorationSet; missing: boolean } {
  const lib = loadedKatex();
  const out: Range<Decoration>[] = [];
  let missing = false;
  const seen = new Set<number>();
  for (const range of ranges) {
    const blocked = blockedSpans(state, range.from, range.to);
    for (const span of inlineMathIn(state, range.from, range.to, blocked)) {
      if (seen.has(span.from)) continue;
      seen.add(span.from);
      if (isTouched(state, span.from, span.to)) continue;
      if (!lib) {
        missing = true;
        continue;
      }
      const render = renderMath(lib, span.tex, false);
      if (render.error !== null) pushError(out, span.from, span.to, render);
      else
        out.push(
          Decoration.replace({ widget: new MathWidget(span.tex, render.html, false) }).range(
            span.from,
            span.to,
          ),
        );
    }
  }
  return { decorations: Decoration.set(out, true), missing };
}

/** Pede o KaTeX uma vez e avisa o editor quando ele chega. */
function requestLibrary(view: EditorView): void {
  void loadKatex().then(
    () => view.dispatch({ effects: mathReady.of(null) }),
    (error: unknown) => console.warn('[simplemd] KaTeX não carregou', error),
  );
}

const readyIn = (update: ViewUpdate) =>
  update.transactions.some((tr) => tr.effects.some((effect) => effect.is(mathReady)));

const inlineMathPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(readonly view: EditorView) {
      this.decorations = this.compute(view.state);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        focusChanged(update) ||
        readyIn(update) ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = this.compute(update.state);
      }
    }

    compute(state: EditorState): DecorationSet {
      const { decorations, missing } = computeInlineMath(state, this.view.visibleRanges);
      if (missing) requestLibrary(this.view);
      return decorations;
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// ---- Blocos `$$` (StateField: o CodeMirror proíbe decorações de bloco vindas de plugins) ----

interface BlockMathState {
  readonly blocks: readonly MathSpan[];
  /** Índices dos blocos tocados pela seleção (com foco). */
  readonly touched: readonly number[];
  readonly decorations: DecorationSet;
}

function touchedBlocks(state: EditorState, blocks: readonly MathSpan[]): number[] {
  const touched: number[] = [];
  blocks.forEach((block, i) => {
    if (isTouched(state, block.from, block.to)) touched.push(i);
  });
  return touched;
}

/** Só o que já está no cache vira widget; o resto fica cru até o plugin companheiro renderizar. */
function blockDecorations(blocks: readonly MathSpan[], touched: readonly number[]): DecorationSet {
  const out: Range<Decoration>[] = [];
  blocks.forEach((block, i) => {
    if (touched.includes(i)) return;
    const render = cachedMath(block.tex, true);
    if (!render) return;
    if (render.error !== null) {
      pushError(out, block.from, block.to, render);
      return;
    }
    out.push(
      Decoration.replace({
        block: true,
        widget: new MathWidget(block.tex, render.html, true),
      }).range(block.from, block.to),
    );
  });
  return Decoration.set(out, true);
}

function blockState(state: EditorState): BlockMathState {
  const blocks = blockMathIn(state, 0, state.doc.length);
  const touched = touchedBlocks(state, blocks);
  return { blocks, touched, decorations: blockDecorations(blocks, touched) };
}

/**
 * Blocos `$$` de topo (R-7.3; arch-frontend r2 §7.2): reescaneados só quando o texto ou a árvore
 * mudam (O(blocos de topo)); seleção e foco só recalculam quais blocos estão tocados.
 */
export const blockMathField = StateField.define<BlockMathState>({
  create: blockState,
  update(value, tr) {
    if (tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state))
      return blockState(tr.state);
    const ready = tr.effects.some((effect) => effect.is(mathReady));
    const focus =
      tr.startState.field(pluginFocusField, false) !== tr.state.field(pluginFocusField, false);
    if (!ready && !tr.selection && !focus) return value;
    const touched = touchedBlocks(tr.state, value.blocks);
    const same =
      touched.length === value.touched.length && touched.every((i, n) => value.touched[n] === i);
    if (!ready && same) return value;
    return { blocks: value.blocks, touched, decorations: blockDecorations(value.blocks, touched) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/**
 * Companheiro dos blocos: os blocos visíveis ainda sem render pedem a biblioteca e são renderizados
 * fora da transação; depois um `mathReady` faz o campo trocar a fonte pelo widget.
 */
const blockMathLoader = ViewPlugin.fromClass(
  class {
    scheduled = false;

    constructor(readonly view: EditorView) {
      this.check();
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || readyIn(update)) this.check();
    }

    check() {
      if (this.scheduled || this.pending().length === 0) return;
      this.scheduled = true;
      void loadKatex().then(
        (lib) => {
          this.scheduled = false;
          const pending = this.pending();
          if (pending.length === 0) return;
          for (const block of pending) renderMath(lib, block.tex, true);
          this.view.dispatch({ effects: mathReady.of(null) });
        },
        (error: unknown) => {
          this.scheduled = false;
          console.warn('[simplemd] KaTeX não carregou', error);
        },
      );
    }

    pending(): MathSpan[] {
      const { blocks } = this.view.state.field(blockMathField);
      return blocks.filter(
        (block) =>
          cachedMath(block.tex, true) === undefined &&
          this.view.visibleRanges.some((r) => r.from <= block.to && r.to >= block.from),
      );
    }
  },
);

/** Estilos (DESIGN §8.18 KTX-OK/KTX-ERROR; só `var(--…)` e literais livres, design-ack T-14). */
const katexTheme = EditorView.theme({
  '.cm-math-error': {
    color: 'var(--color-fg)',
    textDecorationLine: 'underline',
    textDecorationStyle: 'dotted',
    textDecorationColor: 'var(--color-danger)',
  },
  '.cm-math-error, .cm-math-error *': {
    textDecorationThickness: '0.12em',
    textUnderlineOffset: '0.2em',
  },
  '.cm-math-sr': {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
  '.cm-math-block': { color: 'var(--color-fg)' },
  '.cm-math-block .katex-display': { marginBlock: 'var(--dimension-space-2)' },
  // Nenhum contêiner de rolagem dentro do `.cm-content` (DESIGN §8.18, axe).
  '.katex-display': { overflow: 'visible' },
});

/** Extensão `source` do KaTeX: em linha no viewport, blocos `$$` por campo, clique revela. */
export const katexExtension: Extension = [
  pluginFocus,
  inlineMathPlugin,
  blockMathField,
  blockMathLoader,
  revealOnMouseDown('.cm-math, .cm-math-block'),
  katexTheme,
];
