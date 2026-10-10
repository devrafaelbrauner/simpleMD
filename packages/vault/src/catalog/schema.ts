import { toVaultPath } from '../path';

/**
 * Esquema persistido do índice do vault (`.simplemd/index.json`; arch-backend r7 §1.7). v2 (S2)
 * acrescenta os links de saída de cada nota ao v1 do r2; v3 (S9) acrescentará tarefas e
 * propriedades. Qualquer outra versão, ou qualquer campo fora do formato, invalida o arquivo
 * inteiro: o índice é refeito uma vez, sem erro (R-I2.8, D-R7-B08).
 */
export const INDEX_VERSION = 2;

/** Links de saída por nota (R-I2.8): os excedentes não entram e a nota ganha `trunc: ["links"]`. */
export const INDEX_LINKS_MAX = 1000;
export const TITLE_MAX = 1000;
export const TAGS_MAX = 50;
/** Alvo guardado de um link (caminho do vault ≤ 1.024; alvo cru de wikilink ≤ 1.000). */
const LINK_TARGET_MAX = 1024;
const MD_FILE = /\.md$/i;

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

/** Tetos atingidos na extração (S9 acrescenta `tasks`/`props`/`itags`). */
export type TruncatedField = 'links';

/** O que o trabalho fatiável do extrator produz além dos metadados (D-R7-B12b). */
export interface NoteIndexData {
  readonly links: readonly IndexedLink[];
  readonly truncated: readonly TruncatedField[];
}

export interface IndexEntry extends CatalogNoteMeta, NoteIndexData {
  readonly path: string;
  readonly mtime: number;
  readonly size: number;
}

export const EMPTY_INDEX_DATA: NoteIndexData = { links: [], truncated: [] };

const KIND_CODE = { wikilink: 0, inline: 1, reference: 2 } as const;
const CODE_KIND = ['wikilink', 'inline', 'reference'] as const;
const TRUNCATED: Record<string, TruncatedField> = { links: 'links' };

type StoredLink = [number, number, number, number, string];

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

function parseTruncated(value: unknown): TruncatedField[] | null {
  if (value === undefined) return [];
  if (!isStringArray(value) || value.length === 0) return null;
  const out: TruncatedField[] = [];
  for (const item of value) {
    const field = TRUNCATED[item];
    if (field === undefined || out.includes(field)) return null;
    out.push(field);
  }
  return out;
}

/**
 * `index.json` → mapa, ou `null` se qualquer coisa estiver fora do esquema v2 (o índice inteiro é
 * ignorado e refeito; R-9.7, R-I2.8). Copia para um `Map` (sem protótipo herdado do JSON).
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
    const truncated = parseTruncated(e.trunc);
    if (!links || !truncated) return null;
    map.set(path, {
      path,
      mtime: e.mtime as number,
      size: e.size as number,
      title: e.title as string,
      tags: [...(e.tags as string[])],
      date: e.date as string | null,
      fmError: e.fmError as boolean,
      links,
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

/** Só o que vai para o arquivo além de mtime/size: muda quando vale regravar (decisão B do r2). */
export function indexSignature(map: ReadonlyMap<string, IndexEntry>): string {
  return JSON.stringify(
    sortedPaths(map).map((path) => {
      const e = map.get(path) as IndexEntry;
      return [path, e.title, e.tags, e.date, e.fmError, storedLinks(e.links), e.truncated];
    }),
  );
}

export function serializeIndex(map: ReadonlyMap<string, IndexEntry>): string {
  const entries: Record<string, Record<string, unknown>> = {};
  for (const path of sortedPaths(map)) {
    const e = map.get(path) as IndexEntry;
    entries[path] = {
      mtime: e.mtime,
      size: e.size,
      title: e.title.slice(0, TITLE_MAX),
      tags: e.tags.slice(0, TAGS_MAX),
      date: e.date,
      fmError: e.fmError,
      links: storedLinks(e.links),
      ...(e.truncated.length > 0 ? { trunc: [...e.truncated] } : {}),
    };
  }
  return `${JSON.stringify({ version: INDEX_VERSION, entries })}\n`;
}

/** Mesmos dados persistidos (metadados + links), sem mtime/size. */
export function sameIndexData(a: IndexEntry, b: IndexEntry): boolean {
  return (
    a.title === b.title &&
    a.date === b.date &&
    a.fmError === b.fmError &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, i) => tag === b.tags[i]) &&
    a.truncated.length === b.truncated.length &&
    a.truncated.every((field, i) => field === b.truncated[i]) &&
    a.links.length === b.links.length &&
    a.links.every((link, i) => {
      const other = b.links[i] as IndexedLink;
      return (
        link.line === other.line &&
        link.column === other.column &&
        link.length === other.length &&
        link.kind === other.kind &&
        link.target === other.target
      );
    })
  );
}
