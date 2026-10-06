import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * Tema do editor (arch-frontend §2.6; DESIGN §5 e §8.5). Todo valor visual é uma referência
 * `var(--…)` sem literal de fallback: os valores vêm só de `packages/themes/src/tokens.css`
 * (ou do tema aplicado em tempo de execução). Sem destaque de linha ativa e sem transições.
 */
export const markdownEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--color-bg)',
    color: 'var(--color-fg)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': {
    fontFamily: 'var(--fontFamily-mono)',
    fontSize: 'var(--dimension-font-size)',
    lineHeight: '1.6',
    maxWidth: '80ch',
    marginInline: 'auto',
    padding: 'var(--dimension-space-6) var(--dimension-space-6) 40vh',
    caretColor: 'var(--color-fg)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-fg)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--color-selection)' },
});

/** Sintaxe revelada fica atenuada com a cor `muted` (nunca com opacidade). */
export const markdownHighlightStyle = HighlightStyle.define([
  { tag: [tags.processingInstruction, tags.meta, tags.url], color: 'var(--color-muted)' },
]);
