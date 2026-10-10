import type { TreeCursor } from '@lezer/common';
import { HASH_TAGS, parseTaskLine, type ParsedTask } from '../tasks/line';
import {
  editorText,
  mayHaveLinks,
  startLinkExtraction,
  type ExtractedLink,
} from '../wikilinks/extract';
import { headingLevel, headingText } from './heading';
import {
  extractNoteMeta,
  firstHeading1,
  noteMetaFrom,
  readFrontMatter,
  type NoteMeta,
} from './note';
import { compactValue } from './properties';
import type { FrontMatterResult } from './yaml';

/**
 * Extrator do índice v3 do vault (r7 S9; arch-backend r7 §1.7.5). Fica num pedaço sob demanda
 * (`loadNoteIndexer` do índice do core): o catálogo do app o carrega antes de começar o índice, e o
 * pedaço de entrada guarda só o `meta` síncrono do r2 (NFR-54, r7 S9a B1).
 */

/** Valor de propriedade no índice (arch-backend r7 §1.7.3): objeto aninhado vira texto JSON. */
export type IndexPropertyValue =
  string | number | boolean | null | readonly (string | number | boolean | null)[];

/** Tetos do índice v3 aplicados já na extração (R-I9.3); o vault confere de novo ao gravar/ler. */
export const NOTE_TASKS_MAX = 2000;
export const NOTE_PROPS_MAX = 100;
export const NOTE_PROP_KEY_MAX = 200;
export const NOTE_PROP_VALUE_BYTES = 1024;
export const NOTE_ITAGS_MAX = 100;
const ITAG_MAX = 200;

/** Dados do índice v3 de uma nota além dos metadados (arch-backend r7 §1.7.4). */
export interface NoteIndexData {
  readonly links: readonly ExtractedLink[];
  readonly tasks: readonly ParsedTask[];
  /** Front matter (objeto sem protótipo). */
  readonly properties: Readonly<Record<string, IndexPropertyValue>>;
  /** Tags do corpo (`#ideia`), fora de código, links, HTML e front matter; sem repetição. */
  readonly inlineTags: readonly string[];
  /** Tetos atingidos na extração (`links` > 1.000 → aviso LNK-LIMIT). */
  readonly truncated: readonly ('links' | 'tasks' | 'props' | 'itags')[];
}

/** Trabalho fatiável do extrator (D-R7-B12b). */
export interface NoteExtractionJob {
  step(budgetMs: number): boolean;
  result(): NoteIndexData;
  /**
   * Metadados da MESMA nota (depois de `step` devolver `true`), sem analisar de novo (NFR-47): o
   * título vem da árvore do trabalho e o front matter do YAML que ele já leu. Igual a
   * `extractNoteMeta` do mesmo texto.
   */
  meta(): NoteMeta;
}

/**
 * Extrator do índice do vault (arch-backend r7 §1.7.5): `meta` barato e síncrono (o de r2, para a
 * gravação do app) e `start` para o trabalho fatiável (um parse Lezer com wikilinks: links,
 * tarefas, tags do corpo e o título; mais as propriedades do front matter).
 */
export interface NoteExtractor {
  meta(text: string, path: string): NoteMeta;
  start(text: string, path: string): NoteExtractionJob;
}

const encoder = new TextEncoder();

/** Bytes UTF-8 do JSON de um valor (o teto de 1 KiB vale para a forma gravada). */
const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/** Maior prefixo de `text` cujo JSON cabe em `max` bytes (sem partir um par substituto). */
function cutText(text: string, max: number): string {
  if (jsonBytes(text) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (jsonBytes(text.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  const code = text.charCodeAt(lo - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? lo - 1 : lo);
}

type Scalar = string | number | boolean | null;

function scalar(value: unknown): Scalar | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

/** Valor do YAML → valor do índice dentro de 1 KiB; `cut` = foi cortado. */
function propertyValue(value: unknown): { value: IndexPropertyValue; cut: boolean } {
  const single = scalar(value);
  if (single !== undefined) {
    if (typeof single !== 'string') return { value: single, cut: false };
    const text = cutText(single, NOTE_PROP_VALUE_BYTES);
    return { value: text, cut: text !== single };
  }
  if (Array.isArray(value)) {
    const items = value.map(scalar);
    if (items.every((item) => item !== undefined)) {
      const list = items as Scalar[];
      let cut = false;
      while (list.length > 0 && jsonBytes(list) > NOTE_PROP_VALUE_BYTES) {
        list.pop();
        cut = true;
      }
      return { value: list, cut };
    }
  }
  let json: string;
  try {
    json = JSON.stringify(value) ?? compactValue(value);
  } catch {
    json = compactValue(value);
  }
  const text = cutText(json, NOTE_PROP_VALUE_BYTES);
  return { value: text, cut: text !== json };
}

export interface IndexProperties {
  readonly properties: Readonly<Record<string, IndexPropertyValue>>;
  /** Alguma chave foi pulada ou algum valor cortado (`trunc` ∋ `"props"`). */
  readonly truncated: boolean;
}

/**
 * Propriedades do front matter para o índice (R-I9.3), a partir do YAML já lido
 * (`readFrontMatter`): ≤ 100 chaves, chave ≤ 200 caracteres (mais longa é pulada), valores dentro
 * de 1 KiB. Front matter inválido, ausente ou grande demais (`null`) → nada.
 */
export function indexProperties(yaml: FrontMatterResult | null): IndexProperties {
  const properties = Object.create(null) as Record<string, IndexPropertyValue>;
  if (!yaml?.ok) return { properties, truncated: false };
  let truncated = false;
  let count = 0;
  for (const { key, value } of yaml.properties) {
    if (key === '' || key.length > NOTE_PROP_KEY_MAX || Object.hasOwn(properties, key)) {
      truncated = true;
      continue;
    }
    if (count >= NOTE_PROPS_MAX) {
      truncated = true;
      break;
    }
    const item = propertyValue(value);
    if (item.cut) truncated = true;
    Object.defineProperty(properties, key, {
      value: item.value,
      enumerable: true,
      writable: false,
    });
    count++;
  }
  return { properties, truncated };
}

/** Nós cujo texto não tem tags do corpo (código, links, HTML, front matter). */
const NO_TAGS: Readonly<Record<string, true>> = {
  FrontMatter: true,
  FencedCode: true,
  CodeBlock: true,
  InlineCode: true,
  HTMLBlock: true,
  HTMLTag: true,
  Comment: true,
  CommentBlock: true,
  ProcessingInstructionBlock: true,
  LinkReference: true,
  Image: true,
  Autolink: true,
  URL: true,
  Link: true,
  WikiLink: true,
};

/** Linha de tarefa ou `#tag` possível: sem nenhuma das duas, a nota só passa pelos links. */
const TASK_HINT = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:.*?[ \t])?\[[^\]\n]\][ \t]/m;

/**
 * Trabalho do índice v3 de uma nota: links (S2) + tarefas pelos nós `Task` da MESMA árvore, com o
 * parser de linha único (`tasks/line.ts`), tags do corpo fora de {@link NO_TAGS}, propriedades e
 * os metadados. Cada nota é analisada UMA vez (NFR-47): se a extração monta a árvore, o título é o
 * primeiro H1 que o mesmo percurso encontra; senão `firstHeading1` (em janelas) é o único parse. O
 * YAML do front matter também é lido uma vez, para os metadados e as propriedades.
 */
export function startNoteIndexJob(raw: string, path: string): NoteExtractionJob {
  const text = editorText(raw);
  const yaml = readFrontMatter(raw);
  // `search` ignora o `lastIndex` da expressão global.
  const wantsTree = TASK_HINT.test(text) || text.search(HASH_TAGS) >= 0;
  const parses = wantsTree || mayHaveLinks(text);
  const tasks: ParsedTask[] = [];
  let tasksOver = false;
  /** Trechos sem tags, em ordem e sem sobreposição (o percurso não desce neles). */
  const excluded: number[] = [];
  let lineStarts: number[] | null = null;
  let lastTaskLine = -1;
  /**
   * Primeiro H1 da árvore (`null`: H1 vazio, que leva ao nome do arquivo como em `firstHeading1`;
   * `undefined`: nenhum ainda). O percurso não desce em código nem no front matter.
   */
  let heading: string | null | undefined;

  const lineOf = (pos: number): number => {
    if (!lineStarts) {
      lineStarts = [0];
      for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1))
        lineStarts.push(i + 1);
    }
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const visitHeading = (c: TreeCursor) => {
    if (heading === undefined && headingLevel(c.name) === 1)
      heading = headingText(text.slice(c.from, c.to), c.name) || null;
  };

  const visit = (c: TreeCursor) => {
    visitHeading(c);
    if (NO_TAGS[c.name]) {
      excluded.push(c.from, c.to);
      return;
    }
    if (c.name !== 'Task' || tasksOver) return;
    const line = lineOf(c.from);
    if (line === lastTaskLine) return;
    lastTaskLine = line;
    const from = (lineStarts as number[])[line] as number;
    const end = text.indexOf('\n', from);
    const task = parseTaskLine(text.slice(from, end < 0 ? text.length : end), line);
    if (!task) return;
    if (tasks.length >= NOTE_TASKS_MAX) tasksOver = true;
    else tasks.push(task);
  };

  const links = startLinkExtraction(
    raw,
    path,
    wantsTree ? visit : parses ? visitHeading : undefined,
  );
  let props: IndexProperties | null = null;

  const inlineTags = (): { tags: string[]; over: boolean } => {
    const tags: string[] = [];
    if (!wantsTree) return { tags, over: false };
    let k = 0;
    for (const m of text.matchAll(HASH_TAGS)) {
      const at = (m.index as number) + (m[1] as string).length;
      while (k < excluded.length && (excluded[k + 1] as number) <= at) k += 2;
      if (k < excluded.length && (excluded[k] as number) <= at) continue;
      const tag = m[2] as string;
      if (tag.length > ITAG_MAX || tags.includes(tag)) continue;
      if (tags.length >= NOTE_ITAGS_MAX) return { tags, over: true };
      tags.push(tag);
    }
    return { tags, over: false };
  };

  return {
    step(budgetMs) {
      props ??= indexProperties(yaml);
      return links.step(budgetMs);
    },
    result() {
      props ??= indexProperties(yaml);
      const found = links.result();
      const tags = inlineTags();
      const truncated: NoteIndexData['truncated'][number][] = [];
      if (found.truncated) truncated.push('links');
      if (tasksOver) truncated.push('tasks');
      if (props.truncated) truncated.push('props');
      if (tags.over) truncated.push('itags');
      return {
        links: found.links,
        tasks,
        properties: props.properties,
        inlineTags: tags.tags,
        truncated,
      };
    },
    meta: () => noteMetaFrom(yaml, path, () => (parses ? (heading ?? null) : firstHeading1(text))),
  };
}

export function createNoteExtractor(): NoteExtractor {
  return { meta: extractNoteMeta, start: startNoteIndexJob };
}
