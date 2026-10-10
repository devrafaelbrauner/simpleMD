import { EditorView } from '@codemirror/view';

const HAIRLINE = '1px solid color-mix(in srgb, var(--color-border) 45%, var(--color-bg))';
const FOCUS_RING = {
  outline: 'var(--dimension-focus-ring) solid var(--color-accent)',
  outlineOffset: 'var(--dimension-focus-ring)',
};

/**
 * Tema do W3 (DESIGN §R7.6.14; handoff §R7.3 item 2: só `var(--…)`, a mistura hairline e `calc()`
 * de tokens). Sem animação nem rolagem própria (A-32, `scrollable-region-focusable`); a caixa de
 * tarefa e o link usam as classes do núcleo (`cm-md-task`, `cm-md-link`).
 */
export const queryTheme = EditorView.theme({
  '.cm-query': {
    display: 'block',
    backgroundColor: 'var(--color-bg)',
    border: HAIRLINE,
    borderRadius: 'var(--dimension-radius)',
    padding: 'var(--dimension-space-2) var(--dimension-space-3)',
    margin: 'var(--dimension-space-2) 0',
    whiteSpace: 'normal',
    cursor: 'text',
  },
  '.cm-query:focus': { outline: 'none' },
  '.cm-query-head': {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 'var(--dimension-space-2)',
    fontFamily: 'var(--fontFamily-ui)',
    fontSize: 'var(--dimension-ui-font-size)',
    lineHeight: '1.45',
  },
  '.cm-query-head-rows': {
    paddingBottom: 'var(--dimension-space-1)',
    marginBottom: 'var(--dimension-space-1)',
    borderBottom: HAIRLINE,
  },
  '.cm-query-count': {
    fontWeight: 'var(--fontWeight-semibold)',
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--color-fg)',
  },
  '.cm-query-msg': { color: 'var(--color-muted)' },
  '.cm-query-kind': {
    fontFamily: 'var(--fontFamily-mono)',
    fontSize: '12px',
    color: 'var(--color-muted)',
  },
  '.cm-query-slow': {
    margin: 'var(--dimension-space-1) 0 0',
    fontFamily: 'var(--fontFamily-ui)',
    fontSize: '12px',
    color: 'var(--color-muted)',
  },
  '.cm-query-group': {
    fontFamily: 'var(--fontFamily-ui)',
    fontSize: 'var(--dimension-ui-font-size)',
    fontWeight: 'var(--fontWeight-semibold)',
    color: 'var(--color-fg)',
    margin: 'var(--dimension-space-2) 0 var(--dimension-space-1)',
  },
  '.cm-query-list': { listStyle: 'none', margin: '0', padding: '0' },
  '.cm-query-row': {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: '1em minmax(0, 1fr)',
    columnGap: 'var(--dimension-space-2)',
    alignItems: 'start',
    minHeight: 'var(--dimension-explorer-row-height)',
    padding: 'var(--dimension-space-1) var(--dimension-space-2)',
  },
  '.cm-query-row-note': { display: 'block' },
  '.cm-query-row .cm-md-task': { margin: '0.35em 0 0' },
  '.cm-query-desc': { color: 'var(--color-fg)', overflowWrap: 'anywhere' },
  '.cm-query-desc.cm-md-task-done': { color: 'var(--color-muted)' },
  '.cm-query-meta': {
    gridColumn: '2',
    fontFamily: 'var(--fontFamily-ui)',
    fontSize: '12px',
    color: 'var(--color-muted)',
    lineHeight: '1.45',
    overflowWrap: 'anywhere',
  },
  '.cm-query-value': { display: 'inline' },
  '.cm-query-meta .cm-md-link': { fontFamily: 'var(--fontFamily-ui)' },
  '.cm-query-active': { backgroundColor: 'var(--color-hover)' },
  '.cm-query-active::before': {
    content: "''",
    position: 'absolute',
    insetBlock: '0',
    insetInlineStart: '0',
    width: 'calc(var(--dimension-space-1) / 2)',
    backgroundColor: 'var(--color-accent)',
  },
  // Texto `accent` nunca sobre `hover` (brand E-1): na linha ativa o link vira `fg` (sublinhado fica).
  '.cm-query-active .cm-md-link': { color: 'var(--color-fg)' },
  '.cm-query .cm-md-task:focus-visible, .cm-query .cm-md-link:focus-visible': FOCUS_RING,
  '.cm-query .cm-md-task:focus, .cm-query .cm-md-link:focus': FOCUS_RING,
  '.cm-query-table': { width: '100%', borderCollapse: 'collapse' },
  '.cm-query-table th, .cm-query-table td': {
    border: HAIRLINE,
    padding: 'var(--dimension-space-1) var(--dimension-space-2)',
    textAlign: 'start',
    verticalAlign: 'top',
    overflowWrap: 'anywhere',
  },
  '.cm-query-table th': {
    backgroundColor: 'var(--color-code-bg)',
    fontWeight: 'var(--fontWeight-semibold)',
    color: 'var(--color-fg)',
  },
  '.cm-query-table tr.cm-query-row': { display: 'table-row' },
  '.cm-query-alert': {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--dimension-space-2)',
    backgroundColor: 'var(--color-code-bg)',
    color: 'var(--color-fg)',
    borderInlineStart: '2px solid var(--color-danger)',
    padding: 'var(--dimension-space-2) var(--dimension-space-3)',
    overflowWrap: 'anywhere',
    fontFamily: 'var(--fontFamily-ui)',
    fontSize: 'var(--dimension-ui-font-size)',
  },
  '.cm-query-alert p': { margin: '0' },
  '.cm-query-alert svg': {
    color: 'var(--color-danger)',
    flex: 'none',
    width: '1em',
    height: '1em',
    marginTop: '0.2em',
  },
});
