import { ensureSyntaxTree, forceParsing } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { computeLivePreviewDecorations, createMarkdownState, setEditorFocus } from '../../src';

export type DecoKind = 'replace' | 'mark' | 'line' | 'widget';

export interface FlatDeco {
  from: number;
  to: number;
  kind: DecoKind;
  class?: string;
  block?: boolean;
  widget?: WidgetType;
}

/** Achata um `DecorationSet` em objetos simples e ordenados: asserções sem layout (arch §2.7). */
export function flattenDecos(set: DecorationSet): FlatDeco[] {
  const out: FlatDeco[] = [];
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
    const spec = value.spec as { class?: string; widget?: WidgetType; block?: boolean };
    const kind: DecoKind = !value.point
      ? 'mark'
      : spec.widget
        ? 'widget'
        : from === to
          ? 'line'
          : 'replace';
    out.push({
      from,
      to,
      kind,
      ...(spec.class ? { class: spec.class } : {}),
      ...(spec.widget ? { widget: spec.widget, block: Boolean(spec.block) } : {}),
    });
  });
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

export interface PreviewOptions {
  /** Posição do cursor (ou âncora da seleção). Padrão: fim do documento. */
  anchor?: number;
  head?: number;
  /** Foco do editor (F-2). Padrão: `true`. */
  focus?: boolean;
}

/**
 * Estado com a árvore completa, a seleção e o foco pedidos. `ensureSyntaxTree` avança o parse; a
 * transação seguinte publica a árvore completa no estado (`syntaxTree(state)`).
 */
export function previewState(doc: string, opts: PreviewOptions = {}): EditorState {
  const base = createMarkdownState(doc);
  if (!ensureSyntaxTree(base, base.doc.length, 5000)) throw new Error('parse incompleto');
  const anchor = opts.anchor ?? doc.length;
  return base.update({
    selection: { anchor, head: opts.head ?? anchor },
    effects: setEditorFocus.of(opts.focus ?? true),
  }).state;
}

/** Decorações em linha (documento inteiro como faixa visível) e de bloco, achatadas. */
export function decorate(state: EditorState): { inline: FlatDeco[]; block: FlatDeco[] } {
  const { inline, block } = computeLivePreviewDecorations(state, [
    { from: 0, to: state.doc.length },
  ]);
  return { inline: flattenDecos(inline), block: flattenDecos(block) };
}

/** Decorações (em linha + bloco) que começam dentro de `[from, to]`. */
export function decosIn(state: EditorState, from: number, to: number): FlatDeco[] {
  const { inline, block } = decorate(state);
  return [...inline, ...block].filter((d) => d.from >= from && d.from <= to);
}

/**
 * Espera a árvore completa num `EditorView` montado (TA-R2-1/TA-R2-3). Na criação, o CodeMirror
 * analisa só ~20 ms (`Work.Apply`) e publica uma árvore parcial; o resto chega depois, num trabalho
 * em segundo plano, e o live preview decora de novo quando a árvore cresce. Sob carga (CI, suíte
 * embaralhada), 20 ms não bastam para o fixture inteiro. `forceParsing` termina o parse e despacha a
 * árvore completa, como o trabalho em segundo plano faria.
 */
export function fullyParsed(view: EditorView): EditorView {
  if (!forceParsing(view, view.state.doc.length, 5000)) throw new Error('parse incompleto');
  return view;
}
