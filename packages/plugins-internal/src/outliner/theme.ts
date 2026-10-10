import { EditorView } from '@codemirror/view';

/**
 * Tema do outliner (DESIGN §R7.6.13, DA-R7-20/29; só tokens): guias 1 px `border` (P12, ≥ 3:1)
 * com faixa de clique de 1ch e hover 2 px `fg`; marcador de dobra como chip `code-bg`; linhas
 * arrastadas com fundo `hover` e links/wikilinks em `fg` (brand E-1); indicador de destino 2 px
 * `accent` (transitório, fora do orçamento de accent como o anel de foco).
 */
export const outlinerTheme = EditorView.theme({
  '.cm-outliner-guides': {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '0',
    height: '0',
    overflow: 'visible',
    pointerEvents: 'none',
    zIndex: '1',
  },
  '.cm-outliner-guide': {
    position: 'absolute',
    width: '1ch',
    marginLeft: '-0.5ch',
    cursor: 'pointer',
    pointerEvents: 'auto',
  },
  '.cm-outliner-guide::before': {
    content: "''",
    position: 'absolute',
    top: '0',
    bottom: '0',
    left: '50%',
    width: '1px',
    background: 'var(--color-border)',
  },
  '.cm-outliner-guide:hover::before': {
    width: 'calc(var(--dimension-space-1) / 2)',
    marginLeft: '-0.5px',
    background: 'var(--color-fg)',
  },
  '&.cm-editor .cm-foldPlaceholder': {
    display: 'inline-block',
    background: 'var(--color-code-bg)',
    color: 'var(--color-muted)',
    border: 'none',
    borderRadius: 'var(--dimension-radius)',
    padding: '0 var(--dimension-space-1)',
    margin: '0 0 0 var(--dimension-space-1)',
    fontFamily: 'var(--fontFamily-ui)',
    fontSize: '12px',
    lineHeight: '1.45',
    verticalAlign: '0.1em',
    cursor: 'pointer',
  },
  '.cm-outliner-dragging': { background: 'var(--color-hover)' },
  '.cm-outliner-dragging .cm-md-link, .cm-outliner-dragging .cm-md-wikilink': {
    color: 'var(--color-fg)',
  },
  '&.cm-outliner-dnd-active, &.cm-outliner-dnd-active .cm-content': { cursor: 'grabbing' },
  '.cm-outliner-drop': {
    position: 'absolute',
    height: 'calc(var(--dimension-space-1) / 2)',
    background: 'var(--color-accent)',
    pointerEvents: 'none',
    zIndex: '2',
  },
});
