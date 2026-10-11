/**
 * Avaliação de um bloco de consulta e o instantâneo da exportação (R-I9.6, AC-EX.4; DESIGN §R7.6.17).
 * Entrada `./tasks/render` do pacote: a exportação (`apps/desktop/src/export/renderers.ts`) e o
 * contador `queryEvals` do harness importam daqui sem baixar o widget do editor.
 */
import type { TasksCatalog } from '@simplemd/plugin-api/internal/tasks-catalog';
import { localIsoDate } from './query/dates';
import { JS_REFUSED } from './query/dql-parser';
import { unrecognized } from './query/tasks-parser';
import {
  runQuery,
  type NoteRow,
  type QueryKind,
  type QueryResult,
  type ResultGroup,
  type TaskRow,
} from './query/evaluate';

/** Contador do harness (`renderCounts().queryEvals`; NFR-41 "0 reavaliações por edição fora"). */
export const queryCounters = { queryEvals: 0 };

/** Tipo da cerca: `tasks`/`dataview` avaliados, `dataviewjs` sempre recusado (0 execução). */
export type QueryFence = QueryKind | 'dataviewjs';

export function queryFenceOf(info: string): QueryFence | null {
  const word = info.trim().split(/\s/)[0]!.toLowerCase();
  return word === 'tasks' || word === 'dataview' || word === 'dataviewjs' ? word : null;
}

/**
 * Erro de uma avaliação que lançou (defesa em profundidade, CR-S9b-B01; inalcançável com o teto de
 * aninhamento dos parsers): o texto vinculante STR-177 apontando a 1ª linha não vazia do bloco.
 */
export function queryFailure(code: string): QueryResult {
  const lines = code.split('\n');
  const index = Math.max(
    0,
    lines.findIndex((line) => line.trim() !== ''),
  );
  return unrecognized(index + 1, (lines[index] ?? '').trim());
}

/**
 * Uma avaliação (conta em `queryEvals`). `dataviewjs` nunca é analisado nem executado. Nunca lança:
 * roda dentro do `toDOM` do CodeMirror (que não captura exceções) e na exportação.
 */
export function evaluateBlock(
  fence: QueryFence,
  code: string,
  catalog: Pick<TasksCatalog, 'getSnapshot' | 'resolveWikilink' | 'backlinks'>,
  notePath: string,
  now: Date,
): QueryResult {
  if (fence === 'dataviewjs') return { kind: 'error', message: JS_REFUSED, line: 0 };
  queryCounters.queryEvals++;
  try {
    return runQuery(fence, code, {
      notes: catalog.getSnapshot().notes,
      catalog,
      notePath,
      today: localIsoDate(now),
    });
  } catch {
    return queryFailure(code);
  }
}

/** Cabeçalho STR-176: "<n> resultados" (`1 resultado`). */
export function resultCountLabel(count: number): string {
  return count === 1 ? '1 resultado' : `${count} resultados`;
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

function groupsHtml<Row>(
  groups: readonly ResultGroup<Row>[],
  body: (rows: readonly Row[]) => string,
): string {
  return groups
    .map(
      (group) =>
        (group.label === null ? '' : `<p class="smd-query-group">${escapeHtml(group.label)}</p>`) +
        body(group.rows),
    )
    .join('');
}

function taskRowsHtml(rows: readonly TaskRow[]): string {
  const items = rows.map(({ ref, meta, origin }) => {
    const done = /^[xX]$/.test(ref.task.status);
    const details = [...meta, ...(origin === null ? [] : [origin])].join(' · ');
    return (
      `<li><span class="smd-query-box">${done ? '☑' : '☐'}</span> ` +
      `<span class="smd-query-desc${done || ref.task.status === '-' ? ' smd-query-done' : ''}">${escapeHtml(ref.task.text)}</span>` +
      (details === '' ? '' : `<span class="smd-query-meta">${escapeHtml(details)}</span>`) +
      '</li>'
    );
  });
  return `<ul class="smd-query-list">${items.join('')}</ul>`;
}

function listRowsHtml(rows: readonly NoteRow[]): string {
  const items = rows.map(
    (row) =>
      `<li><span class="smd-query-note">${escapeHtml(row.title)}</span>` +
      (row.cells[0] === undefined
        ? ''
        : ` <span class="smd-query-value">${escapeHtml(row.cells[0])}</span>`) +
      '</li>',
  );
  return `<ul class="smd-query-list">${items.join('')}</ul>`;
}

function tableHtml(columns: readonly string[], rows: readonly NoteRow[]): string {
  const head = columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join('');
  const body = rows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.title)}</td>${row.cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * Instantâneo estático de um resultado (AC-EX.4): a mesma informação do widget, sem controles —
 * caixas como texto `☐`/`☑`, origem como texto (sem link), TABLE como `<table>` real. Todo texto
 * vindo das notas sai escapado.
 */
export function queryResultHtml(fence: QueryFence, result: QueryResult): string {
  const kind = fence === 'tasks' ? 'tasks' : 'dataview';
  const label = `<span class="smd-query-kind">${kind}</span>`;
  if (result.kind === 'error')
    return `<div class="smd-query smd-query-error" data-kind="${kind}"><p>⚠ ${escapeHtml(result.message)}</p></div>`;
  if (result.count === 0)
    return `<div class="smd-query" data-kind="${kind}"><p class="smd-query-head"><span class="smd-query-empty">Nenhum resultado</span> ${label}</p></div>`;
  let body: string;
  if (result.kind === 'tasks') body = groupsHtml(result.groups, taskRowsHtml);
  else if (result.kind === 'list') body = groupsHtml(result.groups, listRowsHtml);
  else body = groupsHtml(result.groups, (rows) => tableHtml(result.columns, rows));
  return (
    `<div class="smd-query" data-kind="${kind}">` +
    `<p class="smd-query-head"><span class="smd-query-count">${resultCountLabel(result.count)}</span> ${label}</p>` +
    `${body}</div>`
  );
}

/**
 * Instantâneo de uma cerca da nota `notePath`, na hora da exportação: `null` quando a cerca (`info`)
 * não é de consulta. Reconhecer a cerca aqui mantém a exportação sem nenhum código das consultas no
 * pedaço de entrada (NFR-54).
 */
export type QuerySnapshotRenderer = (info: string, code: string, notePath: string) => string | null;

export function createQuerySnapshotRenderer(
  catalog: Pick<TasksCatalog, 'getSnapshot' | 'resolveWikilink' | 'backlinks'>,
  now: () => Date = () => new Date(),
): QuerySnapshotRenderer {
  return (info, code, notePath) => {
    const fence = queryFenceOf(info);
    return fence && queryResultHtml(fence, evaluateBlock(fence, code, catalog, notePath, now()));
  };
}
