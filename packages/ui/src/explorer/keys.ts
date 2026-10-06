import type { Row } from './rows';

export type ExplorerAction =
  | { readonly type: 'focus'; readonly index: number }
  | { readonly type: 'open'; readonly path: string }
  | { readonly type: 'toggle'; readonly path: string }
  | { readonly type: 'none' };

const NONE: ExplorerAction = { type: 'none' };

/**
 * Teclado da árvore (arch-frontend §5, arch-ux §5.1): ↑/↓ movem, Home/End vão às pontas, → expande
 * ou entra no primeiro filho, ← recolhe ou sobe ao pai, Enter/Espaço abre o arquivo ou alterna a
 * pasta. Função pura, testável sem DOM.
 */
export function explorerKeyReducer(
  rows: readonly Row[],
  focused: number,
  key: string,
): ExplorerAction {
  const last = rows.length - 1;
  const row = rows[focused];
  // Sem item focado (lista recém-carregada): qualquer tecla tratada foca a primeira linha.
  if (!row) return last >= 0 ? { type: 'focus', index: 0 } : NONE;
  switch (key) {
    case 'ArrowDown':
      return { type: 'focus', index: Math.min(focused + 1, last) };
    case 'ArrowUp':
      return { type: 'focus', index: Math.max(focused - 1, 0) };
    case 'Home':
      return { type: 'focus', index: 0 };
    case 'End':
      return { type: 'focus', index: last };
    case 'ArrowRight':
      if (row.kind !== 'dir') return NONE;
      if (!row.expanded) return { type: 'toggle', path: row.path };
      return rows[focused + 1]?.parent === row.path ? { type: 'focus', index: focused + 1 } : NONE;
    case 'ArrowLeft': {
      if (row.kind === 'dir' && row.expanded) return { type: 'toggle', path: row.path };
      const parent = rows.findIndex((r) => r.path === row.parent);
      return parent === -1 ? NONE : { type: 'focus', index: parent };
    }
    case 'Enter':
    case ' ':
      return row.kind === 'dir'
        ? { type: 'toggle', path: row.path }
        : { type: 'open', path: row.path };
    default:
      return NONE;
  }
}
