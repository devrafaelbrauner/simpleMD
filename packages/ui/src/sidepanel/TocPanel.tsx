import type { TocEntry } from '@simplemd/core';

export interface TocPanelProps {
  /** Há uma nota aberta na aba ativa. */
  hasTab: boolean;
  entries: readonly TocEntry[];
  /** Cursor no início da linha do título, rolagem até ela e foco no editor. */
  onGo(pos: number): void;
}

/**
 * C4.2 SUMÁRIO (R-9.5; DESIGN §8.20; UX-R2-D25): `<nav>` "Sumário da nota" com `<ol>` aninhadas
 * de botões, recuo por nível. Sem aba: STR-101; sem títulos: STR-102.
 */
export function TocPanel({ hasTab, entries, onGo }: TocPanelProps) {
  if (!hasTab) return <p className="smd-panel-note">Abra uma nota para ver o sumário.</p>;
  if (entries.length === 0) return <p className="smd-panel-note">Esta nota não tem títulos.</p>;
  const list = (items: readonly TocEntry[]) => (
    <ol className="smd-toc-list">
      {items.map((entry) => (
        <li key={entry.from}>
          <button
            type="button"
            className="smd-toc-item"
            data-testid="toc-item"
            data-level={entry.level}
            title={entry.text}
            style={{
              paddingInlineStart: `calc(var(--dimension-space-3) + ${entry.level - 1} * var(--dimension-space-3))`,
            }}
            onClick={() => onGo(entry.from)}
          >
            {entry.text}
          </button>
          {entry.children.length > 0 && list(entry.children)}
        </li>
      ))}
    </ol>
  );
  return (
    <nav aria-label="Sumário da nota" data-testid="toc" className="smd-toc">
      {list(entries)}
    </nav>
  );
}
