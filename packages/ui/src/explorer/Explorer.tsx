import type { Entry } from '@simplemd/vault';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';
import { useDelayed } from '../lib/use-delayed';
import { explorerKeyReducer } from './keys';
import { buildRows } from './rows';

export type ExplorerStatus = 'loading' | 'ready' | 'error' | 'denied';

export interface ExplorerProps {
  status: ExplorerStatus;
  entries: readonly Entry[];
  expanded: Readonly<Record<string, true>>;
  /** Arquivo da aba ativa (`aria-selected`). */
  activePath: string | null;
  /** Item com o foco itinerante (o único com `tabIndex=0`). */
  focusedPath: string | null;
  onToggle(path: string): void;
  onOpen(path: string): void;
  onFocusPath(path: string): void;
  onRetry(): void;
  onPickOther(): void;
  onOpenVault(): void;
  /** Só testes: o jsdom não carrega a folha de tokens, de onde vem a altura da linha. */
  rowHeight?: number;
}

/** NFR-3: no máximo 5 linhas além da área visível em cada direção (UX-D10). */
const OVERSCAN = 5;
const LOADING_DELAY_MS = 150;
const SLOW_LOADING_MS = 15_000;

function readRowHeight(): number {
  // A altura vem do token (lida uma vez na montagem); nenhum literal duplica o valor (arch-ux §8.1).
  const value = getComputedStyle(document.documentElement).getPropertyValue(
    '--dimension-explorer-row-height',
  );
  return Number.parseFloat(value);
}

/**
 * C1 EXPLORADOR (R-2.7, AC-2.14, AC-2.16): árvore virtualizada com `@tanstack/react-virtual`.
 * Linhas de altura fixa, overscan 5, e o item itinerante sempre montado (UX-D9), para o foco nunca
 * cair no `<body>` quando o usuário rola para longe dele.
 */
export function Explorer(props: ExplorerProps) {
  const { status, entries, expanded, activePath, focusedPath } = props;
  const showLoading = useDelayed(status === 'loading', LOADING_DELAY_MS);
  const showSlow = useDelayed(status === 'loading', SLOW_LOADING_MS);

  return (
    <nav className="smd-explorer" aria-label="Arquivos">
      {status === 'loading' && (
        <div className="smd-explorer-msg" aria-busy="true">
          {showLoading && (
            <>
              <div className="smd-skeleton" aria-hidden="true">
                <span>
                  <i style={{ width: '70%' }} />
                </span>
                <span>
                  <i style={{ width: '40%' }} />
                </span>
                <span>
                  <i style={{ width: '55%' }} />
                </span>
              </div>
              <p role="status" className="smd-muted">
                Carregando arquivos…
              </p>
              {showSlow && <p className="smd-muted">Isto está demorando mais que o esperado.</p>}
            </>
          )}
        </div>
      )}
      {(status === 'error' || status === 'denied') && (
        <div className="smd-explorer-msg">
          <div className="smd-ialert" role="alert">
            <Icon name="warn" />
            <div>
              <p>
                {status === 'error'
                  ? 'Não foi possível listar os arquivos da pasta.'
                  : 'Sem permissão para acessar esta pasta.'}
              </p>
              <div className="smd-ialert-actions">
                {status === 'error' ? (
                  <Button variant="ghost" onClick={props.onRetry}>
                    Tentar novamente
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={props.onPickOther}>
                    Escolher outra pasta…
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {status === 'ready' && entries.length === 0 && (
        <div className="smd-explorer-msg" role="status">
          <p className="smd-explorer-msg-head">Nenhum arquivo .md nesta pasta.</p>
          <p className="smd-muted">Arquivos que não são .md e itens ocultos não aparecem aqui.</p>
          <div>
            <Button variant="secondary" onClick={props.onOpenVault}>
              <Icon name="folder" />
              Abrir pasta…
            </Button>
          </div>
        </div>
      )}
      {status === 'ready' && entries.length > 0 && (
        <Tree
          {...props}
          entries={entries}
          expanded={expanded}
          activePath={activePath}
          focusedPath={focusedPath}
        />
      )}
    </nav>
  );
}

function Tree({
  entries,
  expanded,
  activePath,
  focusedPath,
  onToggle,
  onOpen,
  onFocusPath,
  rowHeight,
}: ExplorerProps) {
  const rows = useMemo(() => buildRows(entries, expanded), [entries, expanded]);
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

  // NFR-1: marca o primeiro quadro com as linhas montadas para estes dados.
  useEffect(() => {
    const frame = requestAnimationFrame(() => performance.mark('simplemd:explorer-rows-mounted'));
    return () => cancelAnimationFrame(frame);
  }, [entries]);

  // Foco por teclado: depois que a linha alvo foi montada, o foco DOM acompanha o item itinerante.
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

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const action = explorerKeyReducer(rows, focusedIndex, event.key);
    if (action.type === 'none') return;
    event.preventDefault();
    if (action.type === 'focus') {
      const target = rows[action.index];
      if (!target) return;
      pendingFocus.current = target.path;
      onFocusPath(target.path);
      virtualizer.scrollToIndex(action.index);
    } else if (action.type === 'toggle') {
      pendingFocus.current = action.path;
      onToggle(action.path);
    } else {
      onOpen(action.path);
    }
  };

  return (
    <div
      ref={scrollRef}
      className="smd-tree"
      role="tree"
      aria-label="Arquivos"
      data-testid="explorer-tree"
      onKeyDown={onKeyDown}
    >
      <div role="presentation" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const isDir = row.kind === 'dir';
          return (
            <div
              key={row.path}
              role="treeitem"
              data-testid="explorer-row"
              data-path={row.path}
              data-kind={row.kind}
              className="smd-row"
              tabIndex={item.index === focusedIndex ? 0 : -1}
              title={row.path}
              aria-level={row.level}
              aria-setsize={row.setsize}
              aria-posinset={row.posinset}
              aria-expanded={isDir ? row.expanded === true : undefined}
              aria-selected={!isDir && row.path === activePath}
              style={{
                transform: `translateY(${item.start}px)`,
                paddingLeft: `calc(var(--dimension-space-2) + ${row.level - 1} * var(--dimension-space-3))`,
              }}
              onFocus={() => {
                if (row.path !== focusedPath) onFocusPath(row.path);
              }}
              onClick={() => {
                if (isDir) onToggle(row.path);
                else onOpen(row.path);
              }}
            >
              {isDir ? (
                <Icon name="chevron" className="smd-row-chevron" />
              ) : (
                <span className="smd-row-spacer" />
              )}
              <span className="smd-row-name">{row.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
