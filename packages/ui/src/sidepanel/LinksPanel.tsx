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

/** Uma ocorrência: linha (0-based) e o contexto (≤ 200 caracteres) com o trecho do link. */
export interface LinksOccurrence {
  readonly line: number;
  /** `null` enquanto a linha da nota de origem não foi lida (contexto preguiçoso, D-R7-B09). */
  readonly context: string | null;
  readonly matchFrom: number;
  readonly matchTo: number;
}

export interface LinksGroup {
  readonly path: string;
  readonly title: string;
  readonly occurrences: readonly LinksOccurrence[];
}

export type LinksPanelStatus = 'no-tab' | 'indexing' | 'empty' | 'ready' | 'error';

export interface LinksPanelProps {
  status: LinksPanelStatus;
  groups: readonly LinksGroup[];
  /** A nota ativa passou do teto de 1.000 links (LNK-LIMIT). */
  overLimit?: boolean;
  /** Abre a nota de origem na linha (0-based) da ocorrência; o foco vai ao editor. */
  onOpen(path: string, line: number): void;
  onRetry(): void;
  /** Grupos pintados (marca `simplemd:links-shown`, NFR-46). */
  onShown?(): void;
}

/** Textos do painel (STR-151…STR-153). */
export const LINKS_TEXT = {
  subtitle: 'Notas que apontam para esta',
  noTab: 'Abra uma nota para ver os links.',
  indexing: 'Indexando…',
  empty: 'Nenhuma nota aponta para esta.',
  error: 'Não foi possível ler os links desta nota.',
  retry: 'Tentar novamente',
  limit: 'Esta nota tem mais de 1.000 links; só os 1.000 primeiros entram no índice.',
  listbox: 'Ocorrências',
} as const;

/** Resumo STR-152: "<n> notas apontam para esta · <m> links" (singular para 1). */
export function linksSummary(notes: number, links: number): string {
  const n =
    notes === 1
      ? '1 nota aponta para esta'
      : `${notes.toLocaleString('pt-BR')} notas apontam para esta`;
  const m = links === 1 ? '1 link' : `${links.toLocaleString('pt-BR')} links`;
  return `${n} · ${m}`;
}

/** Rótulo do grupo STR-153: "<título> — <caminho>, <k> ocorrências". */
export function linksGroupLabel(group: LinksGroup): string {
  const k = group.occurrences.length;
  return `${group.title} — ${group.path}, ${k === 1 ? '1 ocorrência' : `${k} ocorrências`}`;
}

interface FlatOption {
  readonly id: string;
  readonly key: string;
  readonly path: string;
  readonly line: number;
}

/**
 * C4.5 LINKS (R-I2.7; DESIGN §R7.6.5; UX-R7-D18; DA-R7-8): topo fixo com subtítulo, resumo e aviso
 * de limite; corpo = UM `listbox` "Ocorrências" (uma parada de Tab, `aria-activedescendant`, ↑/↓/
 * Home/End/PageUp/PageDown cruzando grupos, Enter abre a origem na linha) com `group` estático por
 * nota e `option` só de texto por ocorrência (nome = conteúdo, sem `aria-label`; WCAG 2.5.3).
 * Estados sem listbox: sem nota, indexando (`aria-live="off"`), vazio e erro com "Tentar novamente".
 * Atualizações nunca roubam o foco; se a opção ativa some, a vizinha assume.
 */
export function LinksPanel({
  status,
  groups,
  overLimit,
  onOpen,
  onRetry,
  onShown,
}: LinksPanelProps) {
  const base = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** O listbox focado saiu do DOM (última ocorrência removida, "Indexando…"): CR-S2-05. */
  const refocus = useRef(false);
  const attachList = useCallback((element: HTMLDivElement | null) => {
    listRef.current = element;
    if (!element) return;
    // A limpeza do ref roda antes de o React tirar o nó do DOM: o foco ainda está nele.
    return () => {
      if (element.ownerDocument.activeElement === element) refocus.current = true;
      listRef.current = null;
    };
  }, []);
  const options = useMemo<FlatOption[]>(() => {
    const out: FlatOption[] = [];
    groups.forEach((group, g) =>
      group.occurrences.forEach((occurrence, o) =>
        out.push({
          id: `${base}-o${g}-${o}`,
          key: `${group.path}\n${occurrence.line}\n${o}`,
          path: group.path,
          line: occurrence.line,
        }),
      ),
    );
    return out;
  }, [groups, base]);
  // Opção ativa por chave + posição: se a chave some numa atualização, a vizinha (mesma posição,
  // senão a última) assume.
  const [activeAt, setActiveAt] = useState<{ key: string | null; index: number }>({
    key: null,
    index: 0,
  });
  const found = options.findIndex((option) => option.key === activeAt.key);
  const activeIndex =
    options.length === 0 ? -1 : found >= 0 ? found : Math.min(activeAt.index, options.length - 1);
  const active = activeIndex >= 0 ? options[activeIndex] : undefined;

  const ready = status === 'ready' && groups.length > 0;
  const shown = useRef(false);
  useEffect(() => {
    if (!ready || shown.current) return;
    shown.current = true;
    const frame = requestAnimationFrame(() => {
      performance.mark('simplemd:links-shown');
      onShown?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, onShown]);

  useLayoutEffect(() => {
    if (!active) return;
    const element = document.getElementById(active.id);
    element?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  // Sem anúncio (LNK-UPDATE): o foco vai ao contêiner do painel em vez de cair no `body`.
  useLayoutEffect(() => {
    if (!refocus.current || listRef.current) return;
    refocus.current = false;
    rootRef.current?.focus();
  });

  const moveTo = (index: number) => {
    const clamped = Math.max(0, Math.min(options.length - 1, index));
    const target = options[clamped];
    if (target) setActiveAt({ key: target.key, index: clamped });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey || options.length === 0) return;
    const optionHeight =
      listRef.current?.querySelector<HTMLElement>('[role="option"]')?.offsetHeight;
    const page =
      optionHeight && listRef.current
        ? Math.max(1, Math.floor(listRef.current.clientHeight / optionHeight) - 1)
        : 10;
    const steps: Record<string, number> = {
      ArrowDown: activeIndex + 1,
      ArrowUp: activeIndex - 1,
      Home: 0,
      End: options.length - 1,
      PageDown: activeIndex + page,
      PageUp: activeIndex - page,
    };
    const next = steps[event.key];
    if (next !== undefined) {
      event.preventDefault();
      moveTo(next);
    } else if (event.key === 'Enter' && active) {
      event.preventDefault();
      onOpen(active.path, active.line);
    }
  };

  if (status === 'no-tab') {
    return (
      <div
        ref={rootRef}
        tabIndex={-1}
        className="smd-links"
        data-testid="links-panel"
        data-state="no-tab"
      >
        <div className="smd-catalog-msg smd-links-msg">
          <p>{LINKS_TEXT.noTab}</p>
        </div>
      </div>
    );
  }

  const links = groups.reduce((sum, group) => sum + group.occurrences.length, 0);
  let flat = 0;
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="smd-links"
      data-testid="links-panel"
      data-state={status}
    >
      <div className="smd-links-top">
        <p className="smd-links-subtitle">{LINKS_TEXT.subtitle}</p>
        {status === 'ready' && (
          <p className="smd-links-summary" data-testid="links-summary">
            {linksSummary(groups.length, links)}
          </p>
        )}
        {overLimit && (
          <p className="smd-links-limit" data-testid="links-limit">
            <Icon name="warn" />
            <span>{LINKS_TEXT.limit}</span>
          </p>
        )}
      </div>
      {status === 'indexing' ? (
        <div className="smd-catalog-msg smd-links-msg">
          <p aria-live="off" data-testid="links-indexing">
            {LINKS_TEXT.indexing}
          </p>
        </div>
      ) : status === 'error' ? (
        <div className="smd-catalog-msg smd-links-msg">
          <div className="smd-ialert" role="alert" data-testid="links-error">
            <Icon name="warn" />
            <p>{LINKS_TEXT.error}</p>
          </div>
          <div>
            <Button variant="ghost" data-testid="links-retry" onClick={onRetry}>
              {LINKS_TEXT.retry}
            </Button>
          </div>
        </div>
      ) : !ready ? (
        <div className="smd-catalog-msg smd-links-msg">
          <p data-testid="links-empty">{LINKS_TEXT.empty}</p>
        </div>
      ) : (
        <div
          ref={attachList}
          className="smd-links-list"
          role="listbox"
          aria-label={LINKS_TEXT.listbox}
          tabIndex={0}
          aria-activedescendant={active?.id}
          data-testid="links-list"
          onKeyDown={onKeyDown}
        >
          {groups.map((group, g) => {
            const labelId = `${base}-g${g}`;
            return (
              <div
                key={group.path}
                role="group"
                aria-labelledby={labelId}
                className="smd-links-group"
                data-testid="links-group"
                data-path={group.path}
              >
                <span id={labelId} className="sr-only">
                  {linksGroupLabel(group)}
                </span>
                <div className="smd-links-group-head" aria-hidden="true">
                  <span className="smd-links-group-line">
                    <span className="smd-links-group-title">{group.title}</span>
                    <span className="smd-chip">{group.occurrences.length}</span>
                  </span>
                  <span className="smd-links-group-path">{group.path}</span>
                </div>
                {group.occurrences.map((occurrence) => {
                  const index = flat++;
                  const option = options[index] as FlatOption;
                  const selected = option.key === active?.key;
                  return (
                    <div
                      key={option.key}
                      id={option.id}
                      role="option"
                      aria-selected={selected}
                      className="smd-links-occurrence"
                      data-testid="links-occurrence"
                      data-path={group.path}
                      data-line={occurrence.line + 1}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setActiveAt({ key: option.key, index });
                        onOpen(group.path, occurrence.line);
                      }}
                    >
                      <Context occurrence={occurrence} />
                      <span className="sr-only"> · </span>
                      <span className="smd-links-line">linha {occurrence.line + 1}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Contexto da linha com o trecho do link em semibold + sublinhado (nunca só cor). */
function Context({ occurrence }: { occurrence: LinksOccurrence }) {
  const { context, matchFrom, matchTo } = occurrence;
  if (context === null) return <span className="smd-links-ctx smd-links-ctx-pending">…</span>;
  return (
    <span className="smd-links-ctx">
      {context.slice(0, matchFrom)}
      <span className="smd-links-match">{context.slice(matchFrom, matchTo)}</span>
      {context.slice(matchTo)}
    </span>
  );
}
