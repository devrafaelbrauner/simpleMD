/**
 * Avaliador das consultas (R-I9.4/R-I9.5/R-I9.6, AC-I9.5) sobre o instantâneo do catálogo privado
 * (`TasksCatalog.getSnapshot()`); `FROM [[nota]]` usa `resolveWikilink` + `backlinks` do catálogo.
 * Puro: o mesmo resultado serve ao widget do editor e ao instantâneo da exportação (AC-EX.4).
 */
import type {
  IndexedNote,
  IndexedTask,
  PropertyValue,
  TaskPriority,
  TaskRef,
  TasksCatalog,
} from '@simplemd/plugin-api/internal/tasks-catalog';
import { parseDataviewQuery, type DqlExpr, type DqlQuery, type DqlSource } from './dql-parser';
import {
  QUERY_LIMIT_MAX,
  parseTasksQuery,
  resolveDateRef,
  type QueryError,
  type TaskFilter,
  type TaskGroupKey,
  type TasksQuery,
} from './tasks-parser';

export type QueryKind = 'tasks' | 'dataview';

export interface TaskRow {
  readonly ref: TaskRef;
  /** Metadados STR-176 em texto ("vence 2026-10-12", "prioridade alta", …), sem emoji. */
  readonly meta: readonly string[];
  /** "<título> › linha <n>" (R-I9.6), ou `null` com `hide backlink`. */
  readonly origin: string | null;
}

export interface NoteRow {
  readonly path: string;
  readonly title: string;
  /** LIST: 0 ou 1 valor; TABLE: um por coluna. */
  readonly cells: readonly string[];
}

export interface ResultGroup<Row> {
  /** Rótulo do `group by` (`null` sem agrupamento). */
  readonly label: string | null;
  readonly rows: readonly Row[];
}

export type QueryResult =
  | QueryError
  | {
      readonly kind: 'tasks';
      readonly count: number;
      readonly groups: readonly ResultGroup<TaskRow>[];
    }
  | {
      readonly kind: 'list';
      readonly count: number;
      readonly groups: readonly ResultGroup<NoteRow>[];
    }
  | {
      readonly kind: 'table';
      readonly count: number;
      readonly columns: readonly string[];
      readonly groups: readonly ResultGroup<NoteRow>[];
    };

/** O que a avaliação lê do catálogo (o instantâneo + 2 consultas de links). */
export interface QuerySource {
  readonly notes: readonly IndexedNote[];
  readonly catalog: Pick<TasksCatalog, 'resolveWikilink' | 'backlinks'>;
  /** Nota onde está o bloco (resolução de `[[nota]]` em `FROM`). */
  readonly notePath: string;
  /** `AAAA-MM-DD` local (R-I9.8). */
  readonly today: string;
}

export const TABLE_LINK_COLUMN = 'Nota';
const EMPTY_CELL = '-';

/** Analisa o bloco pelo tipo da cerca (`dataviewjs` nunca chega aqui: o widget o recusa antes). */
export function parseQuery(kind: QueryKind, source: string): TasksQuery | DqlQuery | QueryError {
  return kind === 'tasks' ? parseTasksQuery(source) : parseDataviewQuery(source);
}

/** Analisa e avalia. */
export function runQuery(kind: QueryKind, text: string, source: QuerySource): QueryResult {
  const query = parseQuery(kind, text);
  if (query.kind === 'error') return query;
  return query.kind === 'tasks' ? evaluateTasks(query, source) : evaluateDataview(query, source);
}

// ── tarefas ──────────────────────────────────────────────────────────────────────────────────

const collator = new Intl.Collator('pt-BR', { numeric: true });
const DONE_STATUS = /^[xX-]$/;
const PRIORITY_LABEL = [
  'prioridade mínima',
  'prioridade baixa',
  null,
  'prioridade média',
  'prioridade alta',
  'prioridade máxima',
] as const;
const PRIORITY_NAME = ['lowest', 'low', 'none', 'medium', 'high', 'highest'] as const;
const PRIORITY_GROUP = [
  'Prioridade mínima',
  'Prioridade baixa',
  'Sem prioridade',
  'Prioridade média',
  'Prioridade alta',
  'Prioridade máxima',
] as const;

interface FoundTask {
  readonly note: IndexedNote;
  readonly task: IndexedTask;
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

function matchesTask(filter: TaskFilter, found: FoundTask, today: string): boolean {
  const { task, note } = found;
  switch (filter.kind) {
    case 'done':
      return DONE_STATUS.test(task.status) === filter.done;
    case 'date': {
      const value = task[filter.field];
      // Como no Tasks: `starts …` também aceita tarefas sem data de início.
      if (value === undefined) return filter.field === 'start';
      const date = resolveDateRef(filter.date, today);
      if (filter.op === 'on') return value === date;
      return filter.op === 'before' ? value < date : value > date;
    }
    case 'has-date':
      return (task[filter.field] !== undefined) === filter.has;
    case 'path':
      return note.path.toLowerCase().includes(filter.text.toLowerCase()) === filter.includes;
    case 'tag': {
      const wanted = filter.tag.toLowerCase();
      return task.tags.some((tag) => tag.toLowerCase().includes(wanted)) === filter.includes;
    }
    case 'description':
      return task.text.toLowerCase().includes(filter.text.toLowerCase()) === filter.includes;
    case 'priority':
      if (filter.cmp === 'is') return task.priority === filter.level;
      return filter.cmp === 'above' ? task.priority > filter.level : task.priority < filter.level;
    case 'recurring':
      return (task.recurrence !== undefined) === filter.recurring;
    case 'and':
      return filter.operands.every((operand) => matchesTask(operand, found, today));
    case 'or':
      return filter.operands.some((operand) => matchesTask(operand, found, today));
    case 'not':
      return !matchesTask(filter.operand, found, today);
  }
}

/** Datas ausentes por último (como no Tasks). */
function compareOptional(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a < b ? -1 : 1;
}

function taskMeta(task: IndexedTask, hide: ReadonlySet<string>): string[] {
  const meta: string[] = [];
  const date = (key: string, label: string, value: string | undefined) => {
    if (value !== undefined && !hide.has(key)) meta.push(`${label} ${value}`);
  };
  date('due date', 'vence', task.due);
  date('scheduled date', 'agendada', task.scheduled);
  date('start date', 'início', task.start);
  date('created date', 'criada', task.created);
  date('done date', 'concluída', task.done);
  date('cancelled date', 'cancelada', task.cancelled);
  const priority = PRIORITY_LABEL[task.priority];
  if (priority && !hide.has('priority')) meta.push(priority);
  if (task.recurrence !== undefined && !hide.has('recurrence rule'))
    meta.push(`repete: ${task.recurrence}`);
  if (task.invalid.length > 0) meta.push('data inválida');
  return meta;
}

export function taskOrigin(note: IndexedNote, task: IndexedTask): string {
  return `${note.title} › linha ${task.line + 1}`;
}

function toTaskRow(found: FoundTask, hide: ReadonlySet<string>, shortMode: boolean): TaskRow {
  return {
    ref: { path: found.note.path, task: found.task },
    meta: shortMode ? [] : taskMeta(found.task, hide),
    origin: hide.has('backlink') ? null : taskOrigin(found.note, found.task),
  };
}

/** Chaves de grupo de uma tarefa (`tags`: uma por tag) com a ordem de cada uma. */
function taskGroupKeys(key: TaskGroupKey, found: FoundTask): { label: string; order: string }[] {
  const { note, task } = found;
  switch (key) {
    case 'path':
      return [{ label: note.path, order: note.path }];
    case 'folder': {
      const folder = folderOf(note.path);
      return [{ label: folder === '' ? '/' : `${folder}/`, order: folder }];
    }
    case 'filename':
      return [{ label: fileNameOf(note.path), order: fileNameOf(note.path) }];
    case 'due':
      return [
        task.due === undefined
          ? { label: 'Sem data de vencimento', order: '\uffff' }
          : { label: task.due, order: task.due },
      ];
    case 'priority':
      return [{ label: PRIORITY_GROUP[task.priority], order: String(5 - task.priority) }];
    case 'tags':
      return task.tags.length === 0
        ? [{ label: 'Sem tags', order: '\uffff' }]
        : task.tags.map((tag) => ({ label: tag, order: tag.toLowerCase() }));
  }
}

function groupRows<T>(
  items: readonly T[],
  keysOf: (item: T) => { label: string; order: string }[],
): { label: string; order: string; items: T[] }[] {
  const groups = new Map<string, { label: string; order: string; items: T[] }>();
  for (const item of items) {
    for (const key of keysOf(item)) {
      let group = groups.get(key.label);
      if (!group) groups.set(key.label, (group = { ...key, items: [] }));
      group.items.push(item);
    }
  }
  return [...groups.values()].sort(
    (a, b) => collator.compare(a.order, b.order) || collator.compare(a.label, b.label),
  );
}

export function evaluateTasks(query: TasksQuery, source: QuerySource): QueryResult {
  const found: FoundTask[] = [];
  for (const note of source.notes)
    for (const task of note.tasks)
      if (query.filters.every((filter) => matchesTask(filter, { note, task }, source.today)))
        found.push({ note, task });

  const byIndex = (a: FoundTask, b: FoundTask) =>
    collator.compare(a.note.path, b.note.path) || a.task.line - b.task.line;
  found.sort((a, b) => {
    for (const { key, reverse } of query.sort) {
      let order: number;
      if (key === 'priority') order = b.task.priority - a.task.priority;
      else if (key === 'path') order = byIndex(a, b);
      else if (key === 'description') order = collator.compare(a.task.text, b.task.text);
      else order = compareOptional(a.task[key], b.task[key]);
      if (order !== 0) return reverse ? -order : order;
    }
    return byIndex(a, b);
  });

  const limited = found.slice(0, Math.min(query.limit ?? QUERY_LIMIT_MAX, QUERY_LIMIT_MAX));
  const row = (item: FoundTask) => toTaskRow(item, query.hide, query.shortMode);
  if (query.group.length === 0)
    return {
      kind: 'tasks',
      count: limited.length,
      groups: [{ label: null, rows: limited.map(row) }],
    };
  // Vários `group by`: uma chave composta "a › b" por combinação (grupos planos, na ordem das chaves).
  const groups = groupRows(limited, (item) =>
    query.group.reduce<{ label: string; order: string }[]>(
      (acc, key) =>
        acc.flatMap((prefix) =>
          taskGroupKeys(key, item).map((part) =>
            prefix.label === ''
              ? part
              : {
                  label: `${prefix.label} › ${part.label}`,
                  order: `${prefix.order}\u0000${part.order}`,
                },
          ),
        ),
      [{ label: '', order: '' }],
    ),
  );
  return {
    kind: 'tasks',
    count: limited.length,
    groups: groups.map((group) => ({ label: group.label, rows: group.items.map(row) })),
  };
}

// ── dataview ─────────────────────────────────────────────────────────────────────────────────

interface DateValue {
  readonly ms: number;
  /** Só o dia (`AAAA-MM-DD`) ou data e hora (`file.mtime`). */
  readonly day: boolean;
}

interface PriorityValue {
  readonly priority: TaskPriority;
}

type Value = string | number | boolean | null | DateValue | PriorityValue | readonly Value[];

const isDate = (value: Value): value is DateValue =>
  typeof value === 'object' && value !== null && 'ms' in value;
const isPriority = (value: Value): value is PriorityValue =>
  typeof value === 'object' && value !== null && 'priority' in value;

/** Meia-noite local de um `AAAA-MM-DD` válido. */
function dayValue(date: string): DateValue {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return { ms: new Date(year, month - 1, day).getTime(), day: true };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function fromProperty(value: PropertyValue | undefined): Value {
  if (value === undefined) return null;
  return value as Value;
}

function noteTags(note: IndexedNote): string[] {
  const tags = new Set<string>();
  for (const tag of [...note.tags, ...note.inlineTags])
    tags.add(tag.startsWith('#') ? tag : `#${tag}`);
  return [...tags];
}

function property(note: IndexedNote, key: string): Value {
  if (Object.hasOwn(note.properties, key)) return fromProperty(note.properties[key]);
  const lower = key.toLowerCase();
  const found = Object.keys(note.properties).find((name) => name.toLowerCase() === lower);
  return found === undefined ? null : fromProperty(note.properties[found]);
}

interface Row {
  readonly note: IndexedNote;
  readonly task: IndexedTask | null;
}

function fieldValue(path: readonly string[], row: Row): Value {
  const { note, task } = row;
  if (path.length === 2) {
    switch (path[1]) {
      case 'name':
        return fileNameOf(note.path);
      case 'path':
        return note.path;
      case 'folder':
        return folderOf(note.path);
      case 'mtime':
        return { ms: note.mtime, day: false };
      case 'size':
        return note.size;
      default:
        return noteTags(note);
    }
  }
  const name = path[0]!;
  if (task) {
    switch (name.toLowerCase()) {
      case 'completed':
        return task.status === 'x' || task.status === 'X';
      case 'status':
        return task.status;
      case 'text':
        return task.text;
      case 'due':
      case 'scheduled':
      case 'start':
      case 'done': {
        const date = task[name.toLowerCase() as 'due' | 'scheduled' | 'start' | 'done'];
        return date === undefined ? null : dayValue(date);
      }
      case 'priority':
        return { priority: task.priority };
      case 'tags':
        return task.tags;
    }
  }
  return property(note, name);
}

/** Converte o par para comparação: texto `AAAA-MM-DD` ↔ data; nome ↔ prioridade. */
function coerce(a: Value, b: Value): [Value, Value] {
  if (isDate(a) && typeof b === 'string' && ISO_DAY.test(b)) return [a, dayValue(b)];
  if (isDate(b) && typeof a === 'string' && ISO_DAY.test(a)) return [dayValue(a), b];
  const level = (v: Value) =>
    typeof v === 'string' ? (PRIORITY_NAME as readonly string[]).indexOf(v.toLowerCase()) : -1;
  if (isPriority(a) && level(b) !== -1) return [a, { priority: level(b) as TaskPriority }];
  if (isPriority(b) && level(a) !== -1) return [{ priority: level(a) as TaskPriority }, b];
  return [a, b];
}

function equals(left: Value, right: Value): boolean {
  const [a, b] = coerce(left, right);
  if (isDate(a) && isDate(b)) return a.ms === b.ms;
  if (isPriority(a) && isPriority(b)) return a.priority === b.priority;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => equals(item, b[i]!));
  return a === b;
}

/** Ordem entre dois valores do mesmo tipo; `null` = tipos incomparáveis. */
function order(left: Value, right: Value): number | null {
  const [a, b] = coerce(left, right);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return collator.compare(a, b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (isDate(a) && isDate(b)) return a.ms - b.ms;
  if (isPriority(a) && isPriority(b)) return a.priority - b.priority;
  return null;
}

function truthy(value: Value): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== false && value !== 0 && value !== '';
}

/** `contains` como no Dataview: listas por elemento (recursivo), texto por trecho. */
function contains(haystack: Value, needle: Value): boolean {
  if (Array.isArray(haystack)) return haystack.some((item) => contains(item, needle));
  if (typeof haystack === 'string' && typeof needle === 'string') return haystack.includes(needle);
  return equals(haystack, needle);
}

function evaluate(expr: DqlExpr, row: Row, today: string): Value {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'date':
      return dayValue(resolveDateRef(expr.date, today));
    case 'field':
      return fieldValue(expr.path, row);
    case 'compare': {
      const a = evaluate(expr.left, row, today);
      const b = evaluate(expr.right, row, today);
      if (expr.op === '=') return equals(a, b);
      if (expr.op === '!=') return !equals(a, b);
      const cmp = order(a, b);
      if (cmp === null) return false;
      if (expr.op === '<') return cmp < 0;
      if (expr.op === '<=') return cmp <= 0;
      return expr.op === '>' ? cmp > 0 : cmp >= 0;
    }
    case 'and':
      return truthy(evaluate(expr.left, row, today)) && truthy(evaluate(expr.right, row, today));
    case 'or':
      return truthy(evaluate(expr.left, row, today)) || truthy(evaluate(expr.right, row, today));
    case 'not':
      return !truthy(evaluate(expr.operand, row, today));
    case 'contains':
      return contains(evaluate(expr.haystack, row, today), evaluate(expr.needle, row, today));
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Texto de um valor numa célula/rótulo. */
export function displayValue(value: Value): string {
  if (value === null || value === '') return EMPTY_CELL;
  if (Array.isArray(value))
    return value.length === 0 ? EMPTY_CELL : value.map(displayValue).join(', ');
  if (isDate(value)) {
    const d = new Date(value.ms);
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return value.day ? day : `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (isPriority(value)) return PRIORITY_NAME[value.priority];
  return String(value);
}

/** Total: `null` por último; tipos diferentes pela ordem de tipo; iguais pela ordem do tipo. */
function sortCompare(a: Value, b: Value): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const cmp = order(a, b);
  if (cmp !== null) return cmp;
  return collator.compare(displayValue(a), displayValue(b));
}

function folderMatches(path: string, folder: string): boolean {
  const base = folder.replace(/\/+$/, '');
  if (base === '') return true;
  return path.startsWith(`${base}/`) || path === base || path === `${base}.md`;
}

function sourceSet(
  from: DqlSource,
  source: QuerySource,
  memo: Map<DqlSource, Set<string> | null>,
): (note: IndexedNote) => boolean {
  switch (from.kind) {
    case 'tag': {
      const wanted = from.tag.toLowerCase();
      return (note) =>
        noteTags(note).some((tag) => {
          const lower = tag.toLowerCase();
          return lower === wanted || lower.startsWith(`${wanted}/`);
        });
    }
    case 'folder':
      return (note) => folderMatches(note.path, from.path);
    case 'link': {
      if (!memo.has(from)) {
        const target = source.catalog.resolveWikilink(source.notePath, from.target);
        memo.set(from, target === null ? null : new Set(source.catalog.backlinks(target)));
      }
      const backlinks = memo.get(from);
      return (note) => backlinks?.has(note.path) ?? false;
    }
    case 'and': {
      const left = sourceSet(from.left, source, memo);
      const right = sourceSet(from.right, source, memo);
      return (note) => left(note) && right(note);
    }
    case 'or': {
      const left = sourceSet(from.left, source, memo);
      const right = sourceSet(from.right, source, memo);
      return (note) => left(note) || right(note);
    }
    case 'not': {
      const operand = sourceSet(from.operand, source, memo);
      return (note) => !operand(note);
    }
  }
}

/** `TASK` do DQL não esconde metadados: um conjunto vazio para todas as linhas (CR-S9b-N12). */
const NO_HIDE: ReadonlySet<string> = new Set();

export function evaluateDataview(query: DqlQuery, source: QuerySource): QueryResult {
  const inFrom = query.from ? sourceSet(query.from, source, new Map()) : () => true;
  const rows: Row[] = [];
  for (const note of source.notes) {
    if (!inFrom(note)) continue;
    if (query.type === 'TASK') {
      for (const task of note.tasks) rows.push({ note, task });
    } else {
      rows.push({ note, task: null });
    }
  }
  const matching = rows.filter((row) =>
    query.where.every((expr) => truthy(evaluate(expr, row, source.today))),
  );
  const byIndex = (a: Row, b: Row) =>
    collator.compare(a.note.path, b.note.path) || (a.task?.line ?? 0) - (b.task?.line ?? 0);
  matching.sort((a, b) => {
    for (const { expr, desc } of query.sort) {
      const left = evaluate(expr, a, source.today);
      const right = evaluate(expr, b, source.today);
      const cmp = sortCompare(left, right);
      // `null` fica por último também em DESC.
      if (cmp !== 0) return desc && left !== null && right !== null ? -cmp : cmp;
    }
    return byIndex(a, b);
  });
  const limited = matching.slice(0, Math.min(query.limit ?? QUERY_LIMIT_MAX, QUERY_LIMIT_MAX));

  const grouped = <R>(toRow: (row: Row) => R): ResultGroup<R>[] => {
    if (!query.groupBy) return [{ label: null, rows: limited.map(toRow) }];
    const keyed = limited.map((row) => ({
      row,
      value: evaluate(query.groupBy!.expr, row, source.today),
    }));
    const groups = new Map<string, { value: Value; rows: R[] }>();
    for (const { row, value } of keyed) {
      const label = displayValue(value);
      let group = groups.get(label);
      if (!group) groups.set(label, (group = { value, rows: [] }));
      group.rows.push(toRow(row));
    }
    return [...groups.entries()]
      .sort(([, a], [, b]) => sortCompare(a.value, b.value))
      .map(([label, group]) => ({ label, rows: group.rows }));
  };

  if (query.type === 'TASK') {
    const groups = grouped((row) => toTaskRow({ note: row.note, task: row.task! }, NO_HIDE, false));
    return { kind: 'tasks', count: limited.length, groups };
  }
  const noteRow = (row: Row, cells: readonly string[]): NoteRow => ({
    path: row.note.path,
    title: row.note.title,
    cells,
  });
  if (query.type === 'LIST') {
    const listExpr = query.listExpr;
    const groups = grouped((row) =>
      noteRow(row, listExpr ? [displayValue(evaluate(listExpr.expr, row, source.today))] : []),
    );
    return { kind: 'list', count: limited.length, groups };
  }
  const groups = grouped((row) =>
    noteRow(
      row,
      query.columns.map((column) => displayValue(evaluate(column.expr, row, source.today))),
    ),
  );
  return {
    kind: 'table',
    count: limited.length,
    columns: [TABLE_LINK_COLUMN, ...query.columns.map((column) => column.label)],
    groups,
  };
}
