import { toVaultPath } from '../path';

/**
 * Esquema persistido do índice do vault (`.simplemd/index.json`; arch-backend r7 §1.7). v2 (S2)
 * acrescentou os links de saída ao v1 do r2; v3 (S9) acrescenta tarefas (`tasks`), propriedades do
 * front matter (`props`) e tags do corpo (`itags`), em tuplas compactas. Qualquer outra versão, ou
 * qualquer campo fora do formato, invalida o arquivo inteiro: o índice é refeito uma vez, sem erro
 * (R-I2.8, R-I9.3, D-R7-B08). Quem vem do v1/v2 reconstrói uma vez.
 */
export const INDEX_VERSION = 3;

/** Links de saída por nota (R-I2.8): os excedentes não entram e a nota ganha `trunc: ["links"]`. */
export const INDEX_LINKS_MAX = 1000;
/** Tarefas por nota (R-I9.3). */
export const INDEX_TASKS_MAX = 2000;
/** Descrição de tarefa guardada (R-I9.3). */
export const INDEX_TASK_TEXT_MAX = 1000;
/** Regra de recorrência guardada (texto depois de 🔁). */
export const INDEX_TASK_RECURRENCE_MAX = 200;
/** Chaves do front matter por nota (R-I9.3). */
export const INDEX_PROPS_MAX = 100;
/** Chave do front matter guardada (mais longa é pulada). */
export const INDEX_PROP_KEY_MAX = 200;
/** Valor de propriedade: escalar ou lista de escalares com JSON ≤ 1 KiB (UTF-8). */
export const INDEX_PROP_VALUE_BYTES = 1024;
/** Tags do corpo por nota. */
export const INDEX_ITAGS_MAX = 100;
export const TITLE_MAX = 1000;
export const TAGS_MAX = 50;
/** Alvo guardado de um link (caminho do vault ≤ 1.024; alvo cru de wikilink ≤ 1.000). */
const LINK_TARGET_MAX = 1024;
/** Uma tag do corpo (`#` + nome) guardada. */
const ITAG_MAX = 200;
const MD_FILE = /\.md$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Metadados de uma nota (o `NoteMeta` do core, sem depender dele). */
export interface CatalogNoteMeta {
  readonly title: string;
  readonly tags: readonly string[];
  readonly date: string | null;
  readonly fmError: boolean;
  readonly fmErrorLine?: number;
}

/**
 * Link de saída (forma legível; o arquivo guarda a tupla compacta). Posição 0-based em unidades
 * UTF-16 do texto no formato do editor (sem BOM, só `\n`). `wikilink`: alvo cru (sem apelido nem
 * `#título`, resolvido na leitura); `inline`/`reference`: caminho do vault já resolvido.
 */
export interface IndexedLink {
  readonly line: number;
  readonly column: number;
  readonly length: number;
  readonly kind: 'wikilink' | 'inline' | 'reference';
  readonly target: string;
}

/** Campos de data de uma tarefa (📅 ⏳ 🛫 ➕ ✅ ❌). */
export type TaskDateField = 'due' | 'scheduled' | 'start' | 'created' | 'done' | 'cancelled';

/**
 * Tarefa (forma legível; mesma forma de `ParsedTask` do core e de `IndexedTask` da interface
 * privada `@simplemd/plugin-api/internal/tasks-catalog`, provada por teste de tipos).
 */
export interface IndexedTask {
  readonly line: number;
  readonly status: string;
  readonly text: string;
  readonly due?: string;
  readonly scheduled?: string;
  readonly start?: string;
  readonly created?: string;
  readonly done?: string;
  readonly cancelled?: string;
  readonly priority: 0 | 1 | 2 | 3 | 4 | 5;
  readonly recurrence?: string;
  readonly tags: readonly string[];
  readonly invalid: readonly TaskDateField[];
}

/** Valor de propriedade do front matter (objeto aninhado chega como texto JSON). */
export type PropertyValue =
  | string
  | number
  | boolean
  | null
  | readonly (string | number | boolean | null)[];

/** Tetos atingidos na extração. */
export type TruncatedField = 'links' | 'tasks' | 'props' | 'itags';

/** O que o trabalho fatiável do extrator produz além dos metadados (D-R7-B12b). */
export interface NoteIndexData {
  readonly links: readonly IndexedLink[];
  readonly tasks: readonly IndexedTask[];
  /** Objeto sem protótipo (chaves como `__proto__` são dados). */
  readonly properties: Readonly<Record<string, PropertyValue>>;
  readonly inlineTags: readonly string[];
  readonly truncated: readonly TruncatedField[];
}

export interface IndexEntry extends CatalogNoteMeta, NoteIndexData {
  readonly path: string;
  readonly mtime: number;
  readonly size: number;
}

/** Propriedades vazias (sem protótipo, congeladas). */
export const EMPTY_PROPERTIES: Readonly<Record<string, PropertyValue>> = Object.freeze(
  Object.create(null) as Record<string, PropertyValue>,
);

export const EMPTY_INDEX_DATA: NoteIndexData = {
  links: [],
  tasks: [],
  properties: EMPTY_PROPERTIES,
  inlineTags: [],
  truncated: [],
};

const KIND_CODE = { wikilink: 0, inline: 1, reference: 2 } as const;
const CODE_KIND = ['wikilink', 'inline', 'reference'] as const;
const TRUNCATED_ORDER: readonly TruncatedField[] = ['links', 'tasks', 'props', 'itags'];
/** Campo legível → chave compacta do arquivo (arch-backend r7 §1.7.2). */
const DATE_KEY: Readonly<Record<TaskDateField, string>> = {
  due: 'due',
  scheduled: 'sch',
  start: 'st',
  created: 'cr',
  done: 'dn',
  cancelled: 'cx',
};
const DATE_FIELDS = Object.keys(DATE_KEY) as TaskDateField[];
const KEY_DATE: Readonly<Record<string, TaskDateField>> = Object.fromEntries(
  DATE_FIELDS.map((field) => [DATE_KEY[field], field]),
);
const TASK_FIELD_KEYS: Readonly<Record<string, true>> = {
  due: true,
  sch: true,
  st: true,
  cr: true,
  dn: true,
  cx: true,
  pr: true,
  rec: true,
  g: true,
  inv: true,
};
const NO_PRIORITY = 2;

type StoredLink = [number, number, number, number, string];
type StoredTask = [number, string, string] | [number, string, string, Record<string, unknown>];

const encoder = new TextEncoder();

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Caminho de nota aceito no índice: normalizado, `.md`, sem segmento oculto. */
export function validIndexPath(path: string): boolean {
  try {
    return (
      toVaultPath(path) === path &&
      MD_FILE.test(path) &&
      !path.split('/').some((segment) => segment.startsWith('.'))
    );
  } catch {
    return false;
  }
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** Valor de propriedade dentro do teto de 1 KiB (JSON em UTF-8). */
export function validPropertyValue(value: unknown): value is PropertyValue {
  if (!isScalar(value) && !(Array.isArray(value) && value.every(isScalar))) return false;
  return encoder.encode(JSON.stringify(value)).length <= INDEX_PROP_VALUE_BYTES;
}

/** Objeto sem protótipo a partir de pares (chaves como `__proto__` viram dados). */
export function propertiesFrom(
  pairs: Iterable<readonly [string, PropertyValue]>,
): Readonly<Record<string, PropertyValue>> {
  const out = Object.create(null) as Record<string, PropertyValue>;
  for (const [key, value] of pairs)
    Object.defineProperty(out, key, { value, enumerable: true, writable: false });
  return out;
}

function parseLinks(value: unknown): IndexedLink[] | null {
  if (!Array.isArray(value) || value.length > INDEX_LINKS_MAX) return null;
  const links: IndexedLink[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 5) return null;
    const [line, column, length, code, target] = item as unknown[];
    const kind = typeof code === 'number' ? CODE_KIND[code] : undefined;
    if (!isCount(line) || !isCount(column) || !isCount(length) || kind === undefined) return null;
    if (typeof target !== 'string' || target === '' || target.length > LINK_TARGET_MAX) return null;
    if (kind !== 'wikilink' && !validIndexPath(target)) return null;
    links.push({ line, column, length, kind, target });
  }
  return links;
}

/** Campos compactos de uma tarefa → forma legível, ou `null` se algo está fora do formato. */
function parseTaskFields(
  line: number,
  status: string,
  text: string,
  fields: Record<string, unknown>,
): IndexedTask | null {
  for (const key of Object.keys(fields)) if (TASK_FIELD_KEYS[key] !== true) return null;
  const dates: Partial<Record<TaskDateField, string>> = {};
  for (const field of DATE_FIELDS) {
    const value = fields[DATE_KEY[field]];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !DATE.test(value)) return null;
    dates[field] = value;
  }
  const { pr, rec, g, inv } = fields;
  if (pr !== undefined && (!isCount(pr) || pr > 5 || pr === NO_PRIORITY)) return null;
  if (rec !== undefined && (typeof rec !== 'string' || rec === '' || rec.length > 200)) return null;
  if (g !== undefined && (!isStringArray(g) || g.length === 0)) return null;
  if (inv !== undefined && (!isStringArray(inv) || inv.length === 0)) return null;
  const invalid: TaskDateField[] = [];
  for (const key of (inv as string[] | undefined) ?? []) {
    const field = Object.hasOwn(KEY_DATE, key) ? KEY_DATE[key] : undefined;
    if (field === undefined || invalid.includes(field) || dates[field] !== undefined) return null;
    invalid.push(field);
  }
  return {
    line,
    status,
    text,
    ...dates,
    priority: (pr ?? NO_PRIORITY) as IndexedTask['priority'],
    ...(rec === undefined ? {} : { recurrence: rec as string }),
    tags: [...((g as string[] | undefined) ?? [])],
    invalid,
  };
}

function parseTasks(value: unknown): IndexedTask[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > INDEX_TASKS_MAX) return null;
  const tasks: IndexedTask[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || (item.length !== 3 && item.length !== 4)) return null;
    const [line, status, text, fields] = item as unknown[];
    if (!isCount(line) || typeof status !== 'string' || status.length !== 1) return null;
    if (typeof text !== 'string' || text.length > INDEX_TASK_TEXT_MAX) return null;
    if (
      item.length === 4 &&
      (typeof fields !== 'object' || fields === null || Array.isArray(fields))
    )
      return null;
    const task = parseTaskFields(line, status, text, (fields ?? {}) as Record<string, unknown>);
    if (!task) return null;
    tasks.push(task);
  }
  return tasks;
}

function parseProps(value: unknown): Readonly<Record<string, PropertyValue>> | null {
  if (value === undefined) return EMPTY_PROPERTIES;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > INDEX_PROPS_MAX) return null;
  const pairs: [string, PropertyValue][] = [];
  for (const key of keys) {
    const item = (value as Record<string, unknown>)[key];
    if (key === '' || key.length > INDEX_PROP_KEY_MAX || !validPropertyValue(item)) return null;
    pairs.push([key, Array.isArray(item) ? [...item] : item]);
  }
  return propertiesFrom(pairs);
}

function parseItags(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!isStringArray(value) || value.length === 0 || value.length > INDEX_ITAGS_MAX) return null;
  if (value.some((tag) => !tag.startsWith('#') || tag.length < 2 || tag.length > ITAG_MAX))
    return null;
  return [...value];
}

function parseTruncated(value: unknown): TruncatedField[] | null {
  if (value === undefined) return [];
  if (!isStringArray(value) || value.length === 0) return null;
  const out: TruncatedField[] = [];
  for (const item of value) {
    const field = TRUNCATED_ORDER.find((f) => f === item);
    if (field === undefined || out.includes(field)) return null;
    out.push(field);
  }
  return out;
}

/**
 * `index.json` → mapa, ou `null` se qualquer coisa estiver fora do esquema v3 (o índice inteiro é
 * ignorado e refeito; R-9.7, R-I2.8, R-I9.3). Copia para um `Map` (sem protótipo herdado do JSON);
 * as propriedades vão para objetos sem protótipo.
 */
export function parseIndex(text: string): Map<string, IndexEntry> | null {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const root = data as Record<string, unknown>;
  const entries = root.entries;
  if (root.version !== INDEX_VERSION || typeof entries !== 'object' || entries === null)
    return null;
  if (Array.isArray(entries)) return null;
  const map = new Map<string, IndexEntry>();
  for (const [path, raw] of Object.entries(entries as Record<string, unknown>)) {
    if (!validIndexPath(path) || typeof raw !== 'object' || raw === null) return null;
    const e = raw as Record<string, unknown>;
    const ok =
      typeof e.mtime === 'number' &&
      Number.isFinite(e.mtime) &&
      typeof e.size === 'number' &&
      Number.isFinite(e.size) &&
      e.size >= 0 &&
      typeof e.title === 'string' &&
      e.title.length <= TITLE_MAX &&
      isStringArray(e.tags) &&
      e.tags.length <= TAGS_MAX &&
      (e.date === null || typeof e.date === 'string') &&
      typeof e.fmError === 'boolean';
    if (!ok) return null;
    const links = parseLinks(e.links);
    const tasks = parseTasks(e.tasks);
    const properties = parseProps(e.props);
    const inlineTags = parseItags(e.itags);
    const truncated = parseTruncated(e.trunc);
    if (!links || !tasks || !properties || !inlineTags || !truncated) return null;
    map.set(path, {
      path,
      mtime: e.mtime as number,
      size: e.size as number,
      title: e.title as string,
      tags: [...(e.tags as string[])],
      date: e.date as string | null,
      fmError: e.fmError as boolean,
      links,
      tasks,
      properties,
      inlineTags,
      truncated,
    });
  }
  return map;
}

/** Ordem por caminho em unidades de código: a serialização é estável entre execuções. */
export function sortedPaths(map: ReadonlyMap<string, unknown>): string[] {
  return [...map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const storedLinks = (links: readonly IndexedLink[]): StoredLink[] =>
  links
    .slice(0, INDEX_LINKS_MAX)
    .map((l) => [l.line, l.column, l.length, KIND_CODE[l.kind], l.target]);

function storedTask(task: IndexedTask): StoredTask {
  const fields: Record<string, unknown> = {};
  for (const field of DATE_FIELDS) {
    const value = task[field];
    if (value !== undefined) fields[DATE_KEY[field]] = value;
  }
  if (task.priority !== NO_PRIORITY) fields.pr = task.priority;
  if (task.recurrence !== undefined) fields.rec = task.recurrence;
  if (task.tags.length > 0) fields.g = [...task.tags];
  if (task.invalid.length > 0) fields.inv = task.invalid.map((field) => DATE_KEY[field]);
  const head: [number, string, string] = [task.line, task.status, task.text];
  return Object.keys(fields).length === 0 ? head : [...head, fields];
}

const storedTasks = (tasks: readonly IndexedTask[]): StoredTask[] =>
  tasks.slice(0, INDEX_TASKS_MAX).map(storedTask);

/** Só o que vai para o arquivo além de mtime/size: muda quando vale regravar (decisão B do r2). */
export function indexSignature(map: ReadonlyMap<string, IndexEntry>): string {
  return JSON.stringify(
    sortedPaths(map).map((path) => {
      const e = map.get(path) as IndexEntry;
      return [
        path,
        e.title,
        e.tags,
        e.date,
        e.fmError,
        storedLinks(e.links),
        storedTasks(e.tasks),
        Object.entries(e.properties),
        e.inlineTags,
        e.truncated,
      ];
    }),
  );
}

export function serializeIndex(map: ReadonlyMap<string, IndexEntry>): string {
  const entries: Record<string, Record<string, unknown>> = {};
  for (const path of sortedPaths(map)) {
    const e = map.get(path) as IndexEntry;
    const props = Object.keys(e.properties);
    entries[path] = {
      mtime: e.mtime,
      size: e.size,
      title: e.title.slice(0, TITLE_MAX),
      tags: e.tags.slice(0, TAGS_MAX),
      date: e.date,
      fmError: e.fmError,
      links: storedLinks(e.links),
      ...(e.tasks.length > 0 ? { tasks: storedTasks(e.tasks) } : {}),
      ...(props.length > 0
        ? { props: Object.fromEntries(props.map((key) => [key, e.properties[key]])) }
        : {}),
      ...(e.inlineTags.length > 0 ? { itags: e.inlineTags.slice(0, INDEX_ITAGS_MAX) } : {}),
      ...(e.truncated.length > 0 ? { trunc: [...e.truncated] } : {}),
    };
  }
  return `${JSON.stringify({ version: INDEX_VERSION, entries })}\n`;
}

/** Mesmos dados persistidos (metadados, links, tarefas, propriedades, tags), sem mtime/size. */
export function sameIndexData(a: IndexEntry, b: IndexEntry): boolean {
  const sameList = <T>(x: readonly T[], y: readonly T[], eq: (p: T, q: T) => boolean) =>
    x.length === y.length && x.every((item, i) => eq(item, y[i] as T));
  const same = (p: unknown, q: unknown) => p === q;
  return (
    a.title === b.title &&
    a.date === b.date &&
    a.fmError === b.fmError &&
    sameList(a.tags, b.tags, same) &&
    sameList(a.truncated, b.truncated, same) &&
    sameList(a.inlineTags, b.inlineTags, same) &&
    sameList(
      a.links,
      b.links,
      (l, o) =>
        l.line === o.line &&
        l.column === o.column &&
        l.length === o.length &&
        l.kind === o.kind &&
        l.target === o.target,
    ) &&
    // Tarefas e propriedades pela forma gravada (a mesma da assinatura).
    JSON.stringify(storedTasks(a.tasks)) === JSON.stringify(storedTasks(b.tasks)) &&
    JSON.stringify(Object.entries(a.properties)) === JSON.stringify(Object.entries(b.properties))
  );
}
