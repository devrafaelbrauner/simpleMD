import type { TextSearchHit, TextSearchNote, TextSearchSkipped } from '@simplemd/vault';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Button } from '../components/ui/button';

/**
 * Id fixo do campo da busca no texto: o comando "Buscar no texto das notas" (`Mod-Shift-G`) leva o
 * foco até ele (há um só Catálogo por janela).
 */
export const CONTENT_SEARCH_FIELD_ID = 'content-search-field';

/**
 * Fases da busca no texto (r37c, design-r37 §4): `pending` espera a pausa da digitação; `short` e
 * `long` recusam a consulta sem tocar o disco; `searching` termina em `done`, `cancelled` (Esc ou
 * "Cancelar"), `unavailable` (plataforma sem busca) ou `error`.
 */
export type ContentSearchStatus =
  | 'idle'
  | 'pending'
  | 'short'
  | 'long'
  | 'searching'
  | 'done'
  | 'cancelled'
  | 'unavailable'
  | 'error';

/** O que o modo "Conteúdo" do Catálogo mostra; o app guarda e publica (`catalog/text-search.ts`). */
export interface ContentSearchState {
  /** Texto do campo. */
  readonly query: string;
  /** A consulta dos resultados mostrados (a da busca mais recente). */
  readonly searched: string;
  readonly status: ContentSearchStatus;
  /** Notas com resultado, na ordem do percurso, com até 5 trechos cada. */
  readonly notes: readonly TextSearchNote[];
  /** Notas examinadas: o progresso e, no fim, o total. */
  readonly scanned: number;
  /** A busca parou em `limit` notas: havia mais. */
  readonly truncated: boolean;
  readonly limit: number;
  /** O que a busca pulou, no fim; `null` antes. */
  readonly skipped: TextSearchSkipped | null;
}

export const CONTENT_SEARCH_IDLE: ContentSearchState = Object.freeze({
  query: '',
  searched: '',
  status: 'idle',
  notes: [],
  scanned: 0,
  truncated: false,
  limit: 0,
  skipped: null,
});

/** Textos do modo "Conteúdo" (design-r37 §4). */
export const CONTENT_SEARCH_TEXT = {
  label: 'Buscar no texto das notas',
  placeholder: 'Texto nas notas',
  idle: 'Acha o termo no corpo das notas, sem diferenciar acentos nem maiúsculas.',
  short: 'Digite ao menos 2 caracteres.',
  long: 'Use no máximo 256 caracteres.',
  cancel: 'Cancelar',
  listbox: 'Resultados',
  unavailable: 'A busca no texto das notas não está disponível aqui.',
  error: 'Não foi possível buscar no texto das notas.',
} as const;

/** UX-D10: até 5 linhas além da área visível em cada direção (≤ 60 montadas; NFR-30). */
const OVERSCAN = 5;

const count = (n: number) => n.toLocaleString('pt-BR');
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

/** "37 resultados em 12 notas": os casamentos contados (até 999 por nota) e as notas. */
export function contentSearchCount(notes: readonly TextSearchNote[]): string {
  const results = notes.reduce((sum, note) => sum + note.total, 0);
  return `${plural(results, 'resultado', 'resultados')} em ${plural(notes.length, 'nota', 'notas')}`;
}

/**
 * Notas que a busca não leu: só na nuvem (D-R37-1), acima de 2 MB, fora do UTF-8 e ilegíveis.
 * Ocultos e links ficam de fora: `links` conta qualquer link, não notas (code review r37a).
 */
export function contentSearchSkipped(skipped: TextSearchSkipped): string | null {
  const parts: string[] = [];
  if (skipped.cloud > 0) parts.push(`${count(skipped.cloud)} só na nuvem`);
  if (skipped.tooLarge > 0) parts.push(`${count(skipped.tooLarge)} acima de 2 MB`);
  if (skipped.notUtf8 > 0) parts.push(`${count(skipped.notUtf8)} fora do UTF-8`);
  if (skipped.unreadable > 0) parts.push(plural(skipped.unreadable, 'ilegível', 'ilegíveis'));
  if (parts.length === 0) return null;
  const total = skipped.cloud + skipped.tooLarge + skipped.notUtf8 + skipped.unreadable;
  return `${plural(total, 'nota não lida', 'notas não lidas')}: ${parts.join(', ')}.`;
}

/**
 * O trecho em três partes, com o destaque limitado ao trecho: `at + len` pode passar do fim (o
 * casamento entra no trecho até 256 unidades; AppSec r37a item 2, code review r37a item 6).
 */
export function snippetParts(
  hit: Pick<TextSearchHit, 'text' | 'at' | 'len'>,
): [before: string, match: string, after: string] {
  const { text } = hit;
  const at = Number.isFinite(hit.at) ? hit.at : 0;
  const len = Number.isFinite(hit.len) ? hit.len : 0;
  const start = Math.min(Math.max(0, at), text.length);
  const end = Math.min(text.length, start + Math.max(0, len));
  return [text.slice(0, start), text.slice(start, end), text.slice(end)];
}

/** Linhas do resumo (região de status): o resultado, o corte e as notas não lidas. */
function summaryOf(state: ContentSearchState): ReactNode[] {
  switch (state.status) {
    case 'short':
      return [CONTENT_SEARCH_TEXT.short];
    case 'long':
      return [CONTENT_SEARCH_TEXT.long];
    case 'unavailable':
      return [CONTENT_SEARCH_TEXT.unavailable];
    case 'error':
      return [CONTENT_SEARCH_TEXT.error];
    case 'cancelled':
      return [
        state.notes.length > 0
          ? `Busca cancelada: ${contentSearchCount(state.notes)}.`
          : 'Busca cancelada.',
      ];
    case 'done': {
      const lines: ReactNode[] = [
        state.notes.length > 0 ? (
          `${contentSearchCount(state.notes)}.`
        ) : (
          <>
            Nenhuma nota contém “<bdi>{state.searched}</bdi>”.
          </>
        ),
      ];
      if (state.truncated)
        lines.push(
          `A busca parou em ${count(state.limit)} notas; refine o termo para ver as outras.`,
        );
      const skipped = state.skipped && contentSearchSkipped(state.skipped);
      if (skipped) lines.push(skipped);
      return lines;
    }
    default:
      return [];
  }
}

interface NoteRow {
  readonly kind: 'note';
  readonly key: string;
  readonly note: TextSearchNote;
  readonly title: string;
}

interface HitRow {
  readonly kind: 'hit';
  readonly key: string;
  readonly note: TextSearchNote;
  readonly title: string;
  readonly hit: TextSearchHit;
  /** Posição entre os trechos (as opções da lista). */
  readonly option: number;
}

type Row = NoteRow | HitRow;

/** Linhas da lista: o cabeçalho de cada nota e um trecho por opção; `options` = índices delas. */
function buildRows(
  notes: readonly TextSearchNote[],
  titleOf: (path: string) => string,
): { rows: Row[]; options: number[] } {
  const rows: Row[] = [];
  const options: number[] = [];
  notes.forEach((note, n) => {
    const title = titleOf(note.path);
    rows.push({ kind: 'note', key: `n${n}`, note, title });
    note.hits.forEach((hit, h) => {
      rows.push({ kind: 'hit', key: `h${n}-${h}`, note, title, hit, option: options.length });
      options.push(rows.length - 1);
    });
  });
  return { rows, options };
}

export interface ContentSearchProps {
  state: ContentSearchState;
  /** Título da nota: o do índice ou, sem ele, o nome do arquivo. */
  titleOf(path: string): string;
  onQueryChange(query: string): void;
  /** Esc no campo ou "Cancelar" com a busca em andamento (ou esperando a pausa da digitação). */
  onCancel(): void;
  /** Enter ou clique num trecho: abre a nota com o trecho selecionado (o foco vai ao editor). */
  onOpen(path: string, hit: TextSearchHit): void;
  /** Só testes: altura da linha do explorador (o jsdom não carrega a folha de tokens). */
  rowHeight?: number;
}

/**
 * Modo "Conteúdo" do Catálogo (r37c, design-r37 §4): campo, "Cancelar", progresso sem anúncio
 * (`aria-live="off"`), resumo numa região de status e o `listbox` virtualizado "Resultados" — uma
 * parada de Tab, a opção itinerante sempre montada, seleção acompanha o foco. Cada nota tem um
 * cabeçalho visual (título, caminho e contagem, fora da árvore de acessibilidade); cada trecho é uma
 * opção de nome "título — linha N: trecho", com o caminho na descrição. Teclado: ↓ do campo vai à
 * lista; ↑/↓/Home/End/PageUp/PageDown; Enter (ou clique) abre; Esc na lista volta ao campo; Esc no
 * campo cancela a busca em andamento ou, sem busca, limpa.
 *
 * Trechos, caminhos e títulos vêm das notas (conteúdo hostil, AppSec r37a item 2; nomes com U+200B,
 * U+17B4 ou U+202E, AppSec r37b): só nós de texto do React (nunca HTML ou markdown), cada um num
 * `<bdi>`, e o `<mark>` nunca passa do fim do trecho.
 */
export function ContentSearch({
  state,
  titleOf,
  onQueryChange,
  onCancel,
  onOpen,
  rowHeight,
}: ContentSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** O foco estava num elemento que saiu do DOM (lista esvaziada, "Cancelar" no fim): vai ao campo. */
  const refocus = useRef(false);
  // A limpeza do ref roda antes de o React tirar o nó do DOM: o foco ainda está nele.
  const attachList = useCallback((element: HTMLDivElement | null) => {
    listRef.current = element;
    if (!element) return;
    return () => {
      if (element.contains(element.ownerDocument.activeElement)) refocus.current = true;
      listRef.current = null;
    };
  }, []);
  const attachCancel = useCallback((element: HTMLButtonElement | null) => {
    if (!element) return;
    return () => {
      if (element.ownerDocument.activeElement === element) refocus.current = true;
    };
  }, []);
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    inputRef.current?.focus();
  });

  // A altura da linha do explorador (token lido uma vez na montagem, como no Catálogo).
  const [rowPx] = useState(
    () =>
      rowHeight ??
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          '--dimension-explorer-row-height',
        ),
      ),
  );
  const { rows, options } = useMemo(() => buildRows(state.notes, titleOf), [state.notes, titleOf]);
  const searching = state.status === 'searching' || state.status === 'pending';
  const summary = summaryOf(state);

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === 'ArrowDown') {
      const active = listRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]');
      if (!active) return;
      event.preventDefault();
      active.focus();
    } else if (event.key === 'Escape' && (searching || state.query !== '')) {
      event.preventDefault();
      event.stopPropagation();
      if (searching) onCancel();
      else onQueryChange('');
    }
  };

  return (
    <div className="smd-content" data-testid="content-search" data-status={state.status}>
      <div className="smd-catalog-top">
        <label htmlFor={CONTENT_SEARCH_FIELD_ID} className="sr-only">
          {CONTENT_SEARCH_TEXT.label}
        </label>
        <div className="smd-content-field">
          <input
            ref={inputRef}
            id={CONTENT_SEARCH_FIELD_ID}
            type="search"
            className="smd-input"
            placeholder={CONTENT_SEARCH_TEXT.placeholder}
            autoComplete="off"
            spellCheck={false}
            data-testid="content-search-input"
            value={state.query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onFieldKeyDown}
          />
          {searching && (
            <Button
              ref={attachCancel}
              variant="secondary"
              className="smd-btn-compact"
              data-testid="content-search-cancel"
              onClick={() => {
                onCancel();
                inputRef.current?.focus();
              }}
            >
              {CONTENT_SEARCH_TEXT.cancel}
            </Button>
          )}
        </div>
        {state.status === 'idle' && <p className="smd-hint">{CONTENT_SEARCH_TEXT.idle}</p>}
        {state.status === 'searching' && (
          <p className="smd-hint" aria-live="off" data-testid="content-search-progress">
            {state.scanned > 0
              ? `Buscando… ${plural(state.scanned, 'nota', 'notas')}`
              : 'Buscando…'}
          </p>
        )}
        {/* Visível sem anúncio; a mesma coisa vai à região de status abaixo (como a contagem). */}
        <div
          className="smd-content-summary"
          aria-hidden="true"
          data-testid="content-search-summary"
        >
          {summary.map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>
        <p className="sr-only" role="status" data-testid="content-search-status">
          {summary.map((line, index) => (
            <Fragment key={index}>
              {index > 0 && ' '}
              {line}
            </Fragment>
          ))}
        </p>
      </div>
      {options.length > 0 && (
        <ResultList
          rows={rows}
          options={options}
          attach={attachList}
          scrollRef={listRef}
          rowPx={rowPx}
          onOpen={onOpen}
          onEscape={() => inputRef.current?.focus()}
        />
      )}
    </div>
  );
}

interface ResultListProps {
  rows: readonly Row[];
  options: readonly number[];
  attach(element: HTMLDivElement | null): (() => void) | undefined;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Altura do cabeçalho de nota; um trecho ocupa duas. */
  rowPx: number;
  onOpen(path: string, hit: TextSearchHit): void;
  onEscape(): void;
}

function ResultList({
  rows,
  options,
  attach,
  scrollRef,
  rowPx,
  onOpen,
  onEscape,
}: ResultListProps) {
  const pendingFocus = useRef<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const found = options.findIndex((index) => rows[index]?.key === activeKey);
  const active = found === -1 ? 0 : found;
  const activeRow = options[active] ?? 0;

  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (activeRow < rows.length && !indexes.includes(activeRow)) {
        indexes.push(activeRow);
        indexes.sort((a, b) => a - b);
      }
      return indexes;
    },
    [activeRow, rows.length],
  );
  // A chave muda com as linhas: tamanhos recalculados quando uma busca nova troca o que há em cada
  // posição (cabeçalho × trecho).
  const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows]);
  const estimateSize = useCallback(
    (index: number) => (rows[index]?.kind === 'note' ? rowPx : 2 * rowPx),
    [rows, rowPx],
  );

  // O React Compiler não é usado no build; o aviso só diz que ele pularia este componente.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN,
    rangeExtractor,
  });

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (target === null || target !== rows[activeRow]?.key) return;
    const element = scrollRef.current?.querySelector<HTMLElement>(`[data-key="${target}"]`);
    if (element) {
      pendingFocus.current = null;
      element.focus();
    }
  });

  const moveTo = (index: number) => {
    const clamped = Math.max(0, Math.min(options.length - 1, index));
    const rowIndex = options[clamped];
    const row = rowIndex === undefined ? undefined : rows[rowIndex];
    if (rowIndex === undefined || !row) return;
    pendingFocus.current = row.key;
    setActiveKey(row.key);
    virtualizer.scrollToIndex(rowIndex);
  };

  const target = (key: string): number | null => {
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / (2 * rowPx)) - 1);
    switch (key) {
      case 'ArrowDown':
        return active + 1;
      case 'ArrowUp':
        return active - 1;
      case 'Home':
        return 0;
      case 'End':
        return options.length - 1;
      case 'PageDown':
        return active + page;
      case 'PageUp':
        return active - page;
      default:
        return null;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
      return;
    }
    const next = target(event.key);
    if (next !== null) {
      event.preventDefault();
      moveTo(next);
    } else if (event.key === 'Enter') {
      const row = rows[activeRow];
      if (row?.kind !== 'hit') return;
      event.preventDefault();
      onOpen(row.note.path, row.hit);
    }
  };

  return (
    <div
      ref={attach}
      className="smd-content-list"
      role="listbox"
      aria-label={CONTENT_SEARCH_TEXT.listbox}
      data-testid="content-search-list"
      onKeyDown={onKeyDown}
    >
      <div role="presentation" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const style = { transform: `translateY(${item.start}px)`, height: item.size };
          if (row.kind === 'note') {
            return (
              <div
                key={row.key}
                aria-hidden="true"
                className="smd-content-note"
                data-testid="content-note"
                data-path={row.note.path}
                style={style}
              >
                <bdi className="smd-content-title">{row.title}</bdi>
                <bdi className="smd-content-path">{row.note.path}</bdi>
                <span className="smd-chip">{count(row.note.total)}</span>
              </div>
            );
          }
          const selected = item.index === activeRow;
          const line = count(row.hit.line + 1);
          return (
            <div
              key={row.key}
              role="option"
              aria-selected={selected}
              aria-setsize={options.length}
              aria-posinset={row.option + 1}
              aria-description={row.note.path}
              tabIndex={selected ? 0 : -1}
              className="smd-content-hit"
              data-testid="content-hit"
              data-key={row.key}
              data-path={row.note.path}
              data-line={row.hit.line + 1}
              style={style}
              onFocus={() => {
                if (row.key !== activeKey) setActiveKey(row.key);
              }}
              onClick={() => {
                setActiveKey(row.key);
                onOpen(row.note.path, row.hit);
              }}
            >
              {/* Nome pelo conteúdo, "título — linha N: trecho": o texto visível fica todo no nome
                  (WCAG 2.5.3, sem `aria-label`); o título só para o leitor de tela. */}
              <span className="sr-only">
                <bdi>{row.title}</bdi>
                {' — '}
              </span>
              <span className="smd-content-line">linha {line}</span>
              <span className="sr-only">: </span>
              <Snippet hit={row.hit} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Trecho só de texto (nós do React), num `<bdi>`, com o casamento em `<mark>` e "…" nos cortes. */
function Snippet({ hit }: { hit: TextSearchHit }) {
  const [before, match, after] = snippetParts(hit);
  return (
    <span className="smd-content-snippet">
      <bdi>
        {hit.cutBefore && '…'}
        {before}
        <mark className="smd-content-mark">{match}</mark>
        {after}
        {hit.cutAfter && '…'}
      </bdi>
    </span>
  );
}
