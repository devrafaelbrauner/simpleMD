import { EditorView } from '@codemirror/view';

/** Hairline do topo das faixas (DESIGN §3.4; a mesma da barra de status C6). */
const HAIRLINE = '1px solid color-mix(in srgb, var(--color-border) 45%, var(--color-bg))';

/**
 * Tema do Vim (DESIGN §R7.6.10, arch-frontend §4.3; só `var(--…)`, handoff §R7.3). Seletores com
 * `.cm-vimCursorLayer` vencem o tema `Prec.highest` da biblioteca (`#ff9696`) sem depender da ordem
 * de montagem. O bloco recebe a cor do caractere em linha da biblioteca: `!important` põe `bg`,
 * menos no bloco parcial (operador pendente/substituir), que a biblioteca deixa transparente.
 */
export const vimTheme = EditorView.theme({
  '.cm-vimCursorLayer .cm-fat-cursor': {
    background: 'var(--color-fg)',
    color: 'var(--color-bg) !important',
    border: 'none',
    outline: 'none',
  },
  '.cm-vimCursorLayer .cm-fat-cursor[style*="color: transparent"]': {
    color: 'transparent !important',
  },
  // D-R7-S4-03: sem foco, o bloco some como o cursor fino do `drawSelection()`.
  '&:not(.cm-focused) .cm-vimCursorLayer .cm-fat-cursor': {
    background: 'none',
    outline: 'none',
    color: 'transparent !important',
  },
  // D-R7-F34: ocorrências da busca como o `<mark>`; a atual é a seleção.
  '.cm-content .cm-searchMatch': { backgroundColor: 'var(--color-hover)', color: 'inherit' },
  // W6: painel na base do editor.
  '.cm-panels .cm-vim-panel': {
    display: 'flex',
    alignItems: 'center',
    minHeight: 'var(--dimension-explorer-row-height)',
    paddingInline: 'var(--dimension-space-3)',
    background: 'var(--color-sidebar-bg)',
    borderTop: HAIRLINE,
    color: 'var(--color-fg)',
    fontFamily: 'var(--fontFamily-mono)',
    fontSize: 'var(--dimension-ui-font-size)',
  },
  '.cm-panels .cm-vim-panel:focus-within': {
    boxShadow: 'inset 0 0 0 var(--dimension-focus-ring) var(--color-accent)',
  },
  '.cm-vim-panel .cm-vim-field': { display: 'flex', flex: '1', whiteSpace: 'pre' },
  '.cm-vim-panel .cm-vim-prefix, .cm-vim-panel .cm-vim-desc': { color: 'var(--color-muted)' },
  '.cm-panels .cm-vim-panel input': {
    flex: '1',
    minWidth: '0',
    padding: '0',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: 'var(--color-fg)',
    font: 'inherit',
  },
  '.cm-vim-panel .cm-vim-message': {
    color: 'var(--color-fg)',
    fontFamily: 'var(--fontFamily-ui)',
    fontSize: '0.75rem',
    whiteSpace: 'pre-wrap',
  },
});
