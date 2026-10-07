import type { EditorState, Extension, Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import {
  focusChanged,
  isTouched,
  pluginFocus,
  revealOnMouseDown,
  warnGlyph,
} from '../shared/reveal';
import { blockedSpans, inlineMathIn, insideAny, type Span } from '../shared/scan';
import { CALC_MAX_LENGTH, renderCalc, type CalcRender } from './render';

/**
 * Chip que substitui `=2+3` (DESIGN §8.18 CLC-OK/CLC-ERROR): `role="img"` com o nome acessível
 * (UX-R2-D23); o erro leva o ⚠ em `danger` e o texto "divisão por zero".
 */
export class CalcWidget extends WidgetType {
  constructor(readonly result: CalcRender) {
    super();
  }

  override eq(other: CalcWidget): boolean {
    return other.result.label === this.result.label;
  }

  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const span = doc.createElement('span');
    span.className = this.result.error ? 'cm-calc-error' : 'cm-calc-result';
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', this.result.label);
    if (this.result.error) span.appendChild(warnGlyph(doc));
    span.appendChild(doc.createTextNode(this.result.text));
    return span;
  }

  override ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown';
  }
}

const isSpace = (char: string | undefined) => char === ' ' || char === '\t';

/**
 * Decorações do calc nas faixas dadas (R-7.4): token que começa com `=` no início da linha ou depois
 * de espaço, até o próximo espaço; fora de código, front matter e matemática; o token tocado fica
 * cru. Função pura do estado (testes e o `ViewPlugin`).
 */
export function computeCalcDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  let lastLine = -1;
  for (const range of ranges) {
    const blocked: Span[] = blockedSpans(state, range.from, range.to);
    const math = inlineMathIn(state, range.from, range.to, blocked);
    const skip = [...blocked, ...math].sort((a, b) => a.from - b.from);
    for (let pos = doc.lineAt(range.from).from; pos <= range.to;) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      if (line.number <= lastLine) continue;
      lastLine = line.number;
      const text = line.text;
      for (let i = text.indexOf('='); i !== -1; i = text.indexOf('=', i + 1)) {
        if (i > 0 && !isSpace(text[i - 1])) continue;
        let end = i + 1;
        while (end < text.length && !isSpace(text[end])) end++;
        if (end - i > CALC_MAX_LENGTH) continue;
        const from = line.from + i;
        const to = line.from + end;
        if (insideAny(skip, from, to - 1) || isTouched(state, from, to)) continue;
        const result = renderCalc(text.slice(i, end));
        if (result)
          out.push(Decoration.replace({ widget: new CalcWidget(result) }).range(from, to));
      }
    }
  }
  return Decoration.set(out, true);
}

const calcPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = computeCalcDecorations(view.state, view.visibleRanges);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        focusChanged(update) ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = computeCalcDecorations(update.state, update.view.visibleRanges);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Estilos do chip (DESIGN §8.18; só `var(--…)`, design-ack T-14). */
const calcTheme = EditorView.theme({
  '.cm-calc-result, .cm-calc-error': {
    fontFamily: 'var(--fontFamily-mono)',
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--color-fg)',
    backgroundColor: 'var(--color-code-bg)',
    borderRadius: 'var(--dimension-radius)',
    paddingInline: 'var(--dimension-space-1)',
  },
  '.cm-calc-error': {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: 'var(--dimension-space-1)',
  },
  '.cm-calc-error svg': { color: 'var(--color-danger)', alignSelf: 'center' },
  '.cm-calc-error > svg': { width: '0.9em', height: '0.9em', flex: 'none' },
});

/** Extensão `source` do calc: foco próprio, decorações no viewport, clique revela e estilos. */
export const calcExtension: Extension = [
  pluginFocus,
  calcPlugin,
  revealOnMouseDown('.cm-calc-result, .cm-calc-error'),
  calcTheme,
];
