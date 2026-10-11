import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, type DecorationSet, type WidgetType } from '@codemirror/view';
import { createMarkdownExtensions } from '@simplemd/core';
import { setPluginFocus } from '../src/shared/reveal';

export interface FlatDeco {
  from: number;
  to: number;
  kind: 'mark' | 'widget' | 'replace';
  class?: string;
  title?: string;
  block?: boolean;
  widget?: WidgetType;
}

/** Achata um `DecorationSet` (asserções sem layout). */
export function flatten(set: DecorationSet): FlatDeco[] {
  const out: FlatDeco[] = [];
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
    const spec = value.spec as {
      class?: string;
      widget?: WidgetType;
      block?: boolean;
      attributes?: { title?: string };
    };
    out.push({
      from,
      to,
      kind: !value.point ? 'mark' : spec.widget ? 'widget' : 'replace',
      ...(spec.class ? { class: spec.class } : {}),
      ...(spec.attributes?.title ? { title: spec.attributes.title } : {}),
      ...(spec.widget ? { widget: spec.widget, block: Boolean(spec.block) } : {}),
    });
  });
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

export interface StateOptions {
  /** Cursor (padrão: fim do documento). */
  anchor?: number;
  /** Foco do editor (padrão: `true`). */
  focus?: boolean;
  /**
   * `false`: árvore só do parse inicial do CM (os primeiros ~3.000 caracteres), como uma nota
   * longa antes do parse de fundo chegar ao fim. Padrão: árvore completa.
   */
  fullParse?: boolean;
}

/** Estado do editor principal (core, com o nó FrontMatter) + a extensão do plugin, árvore completa. */
export function pluginState(
  doc: string,
  extension: Extension,
  opts: StateOptions = {},
): EditorState {
  const base = EditorState.create({ doc, extensions: [createMarkdownExtensions(), extension] });
  if (opts.fullParse !== false && !ensureSyntaxTree(base, base.doc.length, 5000))
    throw new Error('parse incompleto');
  const anchor = opts.anchor ?? doc.length;
  return base.update({ selection: { anchor }, effects: setPluginFocus.of(opts.focus ?? true) })
    .state;
}

const views: EditorView[] = [];

/** `EditorView` montado no `document` do jsdom (destruído por `destroyViews`). */
export function mountView(doc: string, extension: Extension, opts: StateOptions = {}): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({ state: pluginState(doc, extension, opts), parent });
  views.push(view);
  return view;
}

export function destroyViews(): void {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
}

/** Todas as decorações que o view desenha (facet `EditorView.decorations`, inclusive de plugins). */
export function viewDecorations(view: EditorView): FlatDeco[] {
  return view.state
    .facet(EditorView.decorations)
    .flatMap((source) => flatten(typeof source === 'function' ? source(view) : source));
}

export const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
