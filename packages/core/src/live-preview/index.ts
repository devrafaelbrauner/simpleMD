import type { EditorState, Extension } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { editorFocus } from './focus';
import { computeInlineDecorations, inlinePreviewPlugin, type VisibleRange } from './inline';
import { computeBlockDecorations, tableClickHandler, tablePreviewField } from './table';

export { editorFocusField, setEditorFocus } from './focus';
export { computeInlineDecorations, type VisibleRange } from './inline';
export { computeBlockDecorations } from './table';

/**
 * Live preview (R-3.1…R-3.5): decorações em linha só no viewport (`ViewPlugin`) e tabelas como
 * widgets de bloco (`StateField`, o CodeMirror proíbe blocos vindos de plugins). Nenhuma decoração
 * altera o texto do documento (regra 1).
 */
export function livePreview(): Extension {
  return [editorFocus(), inlinePreviewPlugin, tablePreviewField, tableClickHandler];
}

/** Ponto de entrada puro para testes (R-3.3): o que o editor desenharia nas faixas dadas. */
export function computeLivePreviewDecorations(
  state: EditorState,
  ranges: readonly VisibleRange[],
): { inline: DecorationSet; block: DecorationSet } {
  return { inline: computeInlineDecorations(state, ranges), block: computeBlockDecorations(state) };
}
