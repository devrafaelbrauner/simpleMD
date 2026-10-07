import type { CatalogSnapshot, IndexEntry } from '@simplemd/vault';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';
import {
  buildSearchKeys,
  countText,
  dateText,
  filterKeys,
  sortKeys,
  type CatalogSort,
} from './catalog-model';

export interface CatalogPanelProps {
  snapshot: CatalogSnapshot;
  /** Nota da aba ativa (negrito + barra; não é a seleção da lista). */
  activePath: string | null;
  /** Abre a nota numa aba e leva o foco ao editor. */
  onOpen(path: string): void;
  /** Primeiro quadro com linhas e contagem (marca `simplemd:catalog-shown`, NFR-26). */
  onShown?(): void;
  /** Só testes: o jsdom não carrega a folha de tokens, de onde vem a altura da linha. */
  rowHeight?: number;
}

/** UX-D10: até 5 linhas além da área visível em cada direção (≤ 60 montadas; NFR-30). */
const OVERSCAN = 5;
/** O total filtrado é anunciado uma vez, 500 ms depois da última tecla (D-R2-6). */
const ANNOUNCE_DELAY_MS = 500;
const MAX_CHIPS = 2;

function readRowHeight(): number {
  // 2 × a altura da linha do explorador (token lido uma vez na montagem; design-ack r2 §5.3).
  const value = getComputedStyle(document.documentElement).getPropertyValue(
    '--dimension-explorer-row-height',
  );
  return 2 * Number.parseFloat(value);
}

/**
 * C4.1 CATÁLOGO (R-9.6; DESIGN §8.19; UX-R2-D24): busca por título, caminho e `#tag`, ordenação,
 * contagem e a lista virtualizada `listbox` "Notas" (uma parada de Tab, a linha itinerante sempre
 * montada, seleção acompanha o foco). As tags são `<span>`s não focáveis: o teclado filtra
 * digitando `#tag`.
 */
export function CatalogPanel({
  snapshot,
  activePath,
  onOpen,
  onShown,
  rowHeight,
}: CatalogPanelProps) {
  const base = useId();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<CatalogSort>('title');
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const { entries, status } = snapshot;

  const keys = useMemo(() => buildSearchKeys(entries), [entries]);
  const sorted = useMemo(() => sortKeys(keys, sort), [keys, sort]);
  const rows = useMemo(() => filterKeys(sorted, query), [sorted, query]);
  const filtering = query.trim() !== '';
  const count = countText(rows.length, entries.length, filtering);

  // Um anúncio por pausa (digitação ou indexação), com o texto da contagem (D-R2-6).
  useEffect(() => {
    const timer = setTimeout(() => setAnnouncement(count), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [count]);

  // NFR-26: primeiro quadro depois de as linhas e a contagem entrarem no DOM.
  const shown = useRef(false);
  const ready = rows.length > 0 || (status === 'ready' && entries.length === 0);
  useEffect(() => {
    if (shown.current || !ready) return;
    shown.current = true;
    const frame = requestAnimationFrame(() => {
      performance.mark('simplemd:catalog-shown');
      onShown?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, onShown]);

  const clearSearch = () => {
    setQuery('');
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  return (
    <div className="smd-catalog" data-testid="catalog">
      <div className="smd-catalog-top">
        <label htmlFor={`${base}-search`} className="sr-only">
          Buscar no catálogo
        </label>
        <input
          ref={searchRef}
          id={`${base}-search`}
          type="search"
          className="smd-input smd-catalog-search"
          placeholder="Título, caminho ou #tag"
          autoComplete="off"
          spellCheck={false}
          data-testid="catalog-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query !== '') {
              event.preventDefault();
              event.stopPropagation();
              setQuery('');
            }
          }}
        />
        <div className="smd-field-inline">
          <label htmlFor={`${base}-sort`}>Ordenar por</label>
          <select
            id={`${base}-sort`}
            className="smd-input smd-catalog-sort"
            data-testid="catalog-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as CatalogSort)}
          >
            <option value="title">Título (A–Z)</option>
            <option value="date">Data (mais recentes)</option>
            <option value="path">Caminho</option>
          </select>
        </div>
        <p className="smd-hint smd-catalog-count" aria-hidden="true" data-testid="catalog-count">
          {count}
        </p>
        <p className="sr-only" role="status">
          {announcement}
        </p>
        {status === 'building' && (
          <p className="smd-hint" aria-live="off" data-testid="catalog-progress">
            Indexando… {Math.min(snapshot.done, snapshot.total).toLocaleString('pt-BR')} de{' '}
            {snapshot.total.toLocaleString('pt-BR')}
          </p>
        )}
      </div>
      {rows.length > 0 ? (
        <CatalogList
          rows={rows.map((key) => key.entry)}
          activePath={activePath}
          focusedPath={focusedPath}
          onFocusPath={setFocusedPath}
          onOpen={onOpen}
          onTag={(tag) => setQuery(`#${tag}`)}
          rowHeight={rowHeight}
        />
      ) : filtering ? (
        <div className="smd-catalog-msg" data-testid="catalog-empty">
          <p role="status">Nenhuma nota corresponde a “{query.trim()}”.</p>
          <div>
            <Button variant="secondary" onClick={clearSearch}>
              Limpar busca
            </Button>
          </div>
        </div>
      ) : status === 'ready' ? (
        <div className="smd-catalog-msg" data-testid="catalog-empty">
          <p>Nenhuma nota nesta pasta.</p>
        </div>
      ) : null}
    </div>
  );
}

interface CatalogListProps {
  rows: readonly IndexEntry[];
  activePath: string | null;
  focusedPath: string | null;
  onFocusPath(path: string): void;
  onOpen(path: string): void;
  onTag(tag: string): void;
  rowHeight: number | undefined;
}

function CatalogList({
  rows,
  activePath,
  focusedPath,
  onFocusPath,
  onOpen,
  onTag,
  rowHeight,
}: CatalogListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const [rowPx] = useState(() => rowHeight ?? readRowHeight());
  const found = rows.findIndex((row) => row.path === focusedPath);
  const focusedIndex = found === -1 ? 0 : found;

  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (focusedIndex < rows.length && !indexes.includes(focusedIndex)) {
        indexes.push(focusedIndex);
        indexes.sort((a, b) => a - b);
      }
      return indexes;
    },
    [focusedIndex, rows.length],
  );

  // O React Compiler não é usado no build; o aviso só diz que ele pularia este componente.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowPx,
    overscan: OVERSCAN,
    rangeExtractor,
  });

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (target === null || target !== rows[focusedIndex]?.path) return;
    const element = scrollRef.current?.querySelector<HTMLElement>(
      `[data-path="${CSS.escape(target)}"]`,
    );
    if (element) {
      pendingFocus.current = null;
      element.focus();
    }
  });

  const moveTo = (index: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, index));
    const target = rows[clamped];
    if (!target) return;
    pendingFocus.current = target.path;
    onFocusPath(target.path);
    virtualizer.scrollToIndex(clamped);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / rowPx) - 1);
    const steps: Record<string, number> = {
      ArrowDown: focusedIndex + 1,
      ArrowUp: focusedIndex - 1,
      Home: 0,
      End: rows.length - 1,
      PageDown: focusedIndex + page,
      PageUp: focusedIndex - page,
    };
    const next = steps[event.key];
    if (next !== undefined) {
      event.preventDefault();
      moveTo(next);
    } else if (event.key === 'Enter') {
      const row = rows[focusedIndex];
      if (!row) return;
      event.preventDefault();
      onOpen(row.path);
    }
  };

  return (
    <div
      ref={scrollRef}
      className="smd-catalog-list"
      role="listbox"
      aria-label="Notas"
      onKeyDown={onKeyDown}
    >
      <div role="presentation" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const selected = item.index === focusedIndex;
          const extra = row.tags.length - MAX_CHIPS;
          return (
            <div
              key={row.path}
              role="option"
              aria-selected={selected}
              aria-setsize={rows.length}
              aria-posinset={item.index + 1}
              tabIndex={selected ? 0 : -1}
              className="smd-catalog-row"
              data-testid="catalog-row"
              data-path={row.path}
              data-active={row.path === activePath ? '' : undefined}
              style={{ transform: `translateY(${item.start}px)`, height: rowPx }}
              onFocus={() => {
                if (row.path !== focusedPath) onFocusPath(row.path);
              }}
              onClick={() => {
                onFocusPath(row.path);
                onOpen(row.path);
              }}
            >
              <span className="smd-catalog-line">
                <span className="smd-catalog-title">{row.title}</span>
                <span className="smd-catalog-date">{dateText(row)}</span>
              </span>
              <span className="smd-catalog-line">
                <span className="smd-catalog-path">{row.path}</span>
                {row.tags.slice(0, MAX_CHIPS).map((tag) => (
                  <span
                    key={tag}
                    className="smd-chip"
                    data-testid="catalog-tag"
                    data-tag={tag}
                    title={`Filtrar por #${tag}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onTag(tag);
                    }}
                  >
                    #{tag}
                  </span>
                ))}
                {extra > 0 && <span className="smd-catalog-more">+{extra}</span>}
                {row.fmError && (
                  <span className="smd-catalog-badge">
                    <Icon name="warn" />
                    YAML inválido
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
