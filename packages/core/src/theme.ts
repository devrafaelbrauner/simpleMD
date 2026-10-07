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

  // Live preview (DESIGN §8.5). Tamanhos de título vêm dos tokens (em), H5/H6 ficam em 1em.
  '.cm-md-h1': { fontSize: 'var(--dimension-h1-size)' },
  '.cm-md-h2': { fontSize: 'var(--dimension-h2-size)' },
  '.cm-md-h3': { fontSize: 'var(--dimension-h3-size)' },
  '.cm-md-h4': { fontSize: 'var(--dimension-h4-size)' },
  '.cm-md-h1, .cm-md-h2, .cm-md-h3, .cm-md-h4': { lineHeight: '1.3', paddingTop: '0.4em' },
  '.cm-md-h1, .cm-md-h2, .cm-md-h3, .cm-md-h4, .cm-md-h5, .cm-md-h6, .cm-md-strong': {
    fontWeight: 'var(--fontWeight-bold)',
  },
  '.cm-md-h6, .cm-md-bullet, .cm-md-list-number, .cm-md-fence-dim': {
    color: 'var(--color-muted)',
  },
  '.cm-md-em': { fontStyle: 'italic' },
  '.cm-md-link': {
    color: 'var(--color-accent)',
    textDecoration: 'underline',
    textDecorationThickness: '1px',
    textUnderlineOffset: '0.2em',
    cursor: 'text',
  },
  '.cm-md-bullet': { display: 'inline-block', width: '1ch' },
  '.cm-md-codeblock, .cm-md-table-src, .cm-md-frontmatter': {
    backgroundColor: 'var(--color-code-bg)',
  },
  // Front matter (DESIGN §8.18 FME-CLASS): texto `fg`, linhas `---`/`...` em `muted`.
  '.cm-md-frontmatter': { color: 'var(--color-fg)' },
  '.cm-md-frontmatter-delim': { color: 'var(--color-muted)' },
  // Espaço vertical como padding do invólucro, não margem (design-ack DV-4).
  '.cm-md-table-wrap': { padding: 'var(--dimension-space-1) 0' },
  '.cm-md-table': { borderCollapse: 'collapse' },
  '.cm-md-table th, .cm-md-table td': {
    padding: 'calc(var(--dimension-space-1) / 2) var(--dimension-space-3)',
    border: '1px solid color-mix(in srgb, var(--color-border) 45%, var(--color-bg))',
  },
  '.cm-md-table th': {
    backgroundColor: 'var(--color-code-bg)',
    fontWeight: 'var(--fontWeight-bold)',
  },
});

/** Sintaxe revelada fica atenuada com a cor `muted` (nunca com opacidade). */
export const markdownHighlightStyle = HighlightStyle.define([
  { tag: [tags.processingInstruction, tags.meta, tags.url], color: 'var(--color-muted)' },
]);
