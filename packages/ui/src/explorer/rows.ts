import type { Entry } from '@simplemd/vault';

/** Linha visível da árvore (arch-frontend §5): dados para `treeitem` virtualizado. */
export interface Row {
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'dir';
  /** 1 na raiz (`aria-level`). */
  readonly level: number;
  readonly posinset: number;
  readonly setsize: number;
  readonly parent: string;
  readonly expanded?: boolean;
}

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/**
 * Achata a lista em pré-ordem do `list` (pastas primeiro) nas linhas visíveis: descendentes de
 * pastas recolhidas ficam de fora. `aria-setsize`/`aria-posinset` vêm da lista completa, porque a
 * virtualização remove irmãos do DOM. O(n).
 */
export function buildRows(
  entries: readonly Entry[],
  expanded: Readonly<Record<string, true>>,
): Row[] {
  const siblings = new Map<string, number>();
  for (const entry of entries) {
    const parent = parentOf(entry.path);
    siblings.set(parent, (siblings.get(parent) ?? 0) + 1);
  }
  const position = new Map<string, number>();
  const rows: Row[] = [];
  let hiddenUnder: string | null = null;
  for (const entry of entries) {
    const parent = parentOf(entry.path);
    const posinset = (position.get(parent) ?? 0) + 1;
    position.set(parent, posinset);
    if (hiddenUnder !== null && entry.path.startsWith(`${hiddenUnder}/`)) continue;
    hiddenUnder = null;
    const isDir = entry.kind === 'dir';
    const open = isDir && expanded[entry.path] === true;
    if (isDir && !open) hiddenUnder = entry.path;
    rows.push({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      level: entry.path.split('/').length,
      posinset,
      setsize: siblings.get(parent) ?? 1,
      parent,
      ...(isDir ? { expanded: open } : {}),
    });
  }
  return rows;
}
