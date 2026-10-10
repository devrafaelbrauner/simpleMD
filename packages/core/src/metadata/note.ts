import { markdownLanguage } from '@codemirror/lang-markdown';
import { TreeFragment, type Tree, type TreeCursor } from '@lezer/common';
import type { MarkdownParser } from '@lezer/markdown';
import { detectFrontMatter } from '../frontmatter/detect';
import { frontMatterSyntax } from '../frontmatter/lezer';
import { parseTaskLine, TAG_NAME_SOURCE, type ParsedTask } from '../tasks/line';
import { editorText, startLinkExtraction, type ExtractedLink } from '../wikilinks/extract';
import { headingLevel, headingText, NO_HEADING_BLOCKS } from './heading';
import { compactValue } from './properties';
import { parseFrontMatterYaml } from './yaml';

/** Metadados de uma nota no índice do vault (arch-backend r2 §1.4): nunca o corpo. */
export interface NoteMeta {
  readonly title: string;
  readonly tags: readonly string[];
  readonly date: string | null;
  readonly fmError: boolean;
  /** Linha do erro no arquivo, quando `fmError`. */
  readonly fmErrorLine?: number;
}

/** Teto do título no índice (validação do `index.json`, arch-backend r2 §1.4). */
export const NOTE_TITLE_MAX = 1000;

/** O mesmo Markdown do editor (GFM + nó `FrontMatter`), para a árvore do índice ser a do editor. */
const parser = (markdownLanguage.parser as MarkdownParser).configure([frontMatterSyntax]);

/** Nome do arquivo sem `.md` (último recurso da regra de título). */
export function fileTitle(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

/**
 * Espião do PERF-R2-01 / R4-01: trabalho de parse de `firstHeading1`, somando o comprimento de cada
 * árvore produzida (`tree.length`, até onde o parser foi de fato). Conta também o trecho que veio
 * reaproveitado, então é um limite superior: re-analisar um bloco gigante em várias janelas aparece.
 */
export const headingParseCounts = { chars: 0 };

/** Primeira janela do parse (caracteres); cada rodada seguinte cobre 4× mais. */
const FIRST_WINDOW = 4096;

/** H1 no `tree` (completo até `upto`, ou inteiro se `upto` é `null`), ou `undefined` se ainda não há. */
function heading1In(tree: Tree, text: string, upto: number | null): string | null | undefined {
  // Numa árvore parcial, o último bloco pode mudar com as linhas seguintes (um parágrafo vira título
  // setext); só o que termina antes dele é definitivo.
  const stable = upto === null ? Infinity : (tree.topNode.lastChild?.from ?? 0);
  let found: string | null | undefined;
  tree.iterate({
    enter(node) {
      if (found !== undefined || NO_HEADING_BLOCKS[node.name] || node.from >= stable) return false;
      if (headingLevel(node.name) === 1) {
        found = headingText(text.slice(node.from, node.to), node.name) || null;
        return false;
      }
      return undefined;
    },
  });
  return found !== undefined || upto === null ? (found ?? null) : undefined;
}

/**
 * Primeiro H1 (ATX ou setext) fora de código e do front matter, ou `null`. `text` já no formato do
 * editor (sem BOM, só `\n`).
 *
 * PERF-R2-01: o parse avança em janelas crescentes (4 KB, 16 KB, …) reaproveitando a árvore já feita
 * (`TreeFragment`), e para no primeiro H1 definitivo. Uma nota de 10 mil linhas com o título no
 * início custa uma janela, não o documento inteiro. Sem `#`/`=` que possa abrir um H1, nem analisa.
 *
 * R4-01: o Lezer só confere o limite entre blocos, então um bloco folha gigante (parágrafo de linhas
 * simples, citação longa, `data:` numa linha, cerca de código) é consumido inteiro dentro da janela
 * e, por ser o último bloco, não é reaproveitado. Quando isso acontece, a próxima rodada já é o
 * documento inteiro (no máximo ~2× um parse completo); se o parser chegou ao fim, a árvore é final.
 *
 * R5-01: só um bloco que cruza a borda E é maior que a janela leva ao parse completo. Um bloco
 * pequeno que cruza a borda é re-analisado na janela seguinte (4×), e os fragmentos guardam todo o
 * resto; antes, quase toda janela cruzava a borda e as de 16 KB e 64 KB nunca eram usadas. Uma
 * janela parcial só é tentada se o trabalho já feito mais 2× ela (a janela e um bloco que a cruza)
 * cabe no documento; senão a próxima rodada já é o documento inteiro. Assim o trabalho fica ≤ 2× o
 * documento quando nenhum bloco maior que a janela cruza uma borda depois da primeira (sem a regra,
 * uma nota logo acima de 16/64/256 KB com o H1 no fim chegava a 2,33×).
 */
export function firstHeading1(text: string): string | null {
  if (!/#(?:[ \t\n]|$)|=[ \t]*(?:\n|$)/.test(text)) return null;
  let fragments: readonly TreeFragment[] = [];
  let upto = Math.min(FIRST_WINDOW, text.length);
  let spent = 0;
  for (;;) {
    const parse = parser.startParse(text, fragments);
    if (upto < text.length) parse.stopAt(upto);
    let tree: Tree | null = null;
    while (!tree) tree = parse.advance();
    headingParseCounts.chars += tree.length;
    spent += tree.length;
    const complete = upto >= text.length || tree.length >= text.length;
    const found = heading1In(tree, text, complete ? null : upto);
    if (found !== undefined) return found;
    const last = tree.topNode.lastChild;
    const next = Math.min(upto * 4, text.length);
    const giant = last && last.to > upto && last.to - last.from > upto;
    upto = giant || spent + 2 * next > text.length ? text.length : next;
    fragments = TreeFragment.addTree(tree, fragments, true);
  }
}

/**
 * Metadados de uma nota a partir do texto CRU do arquivo (BOM/CRLF possíveis). Título (R-9.3):
 * `title` do front matter > primeiro H1 fora de código > nome do arquivo. Front matter inválido
 * marca `fmError` (com a linha); acima de 256 KB o YAML não é lido (R-9.1).
 */
export function extractNoteMeta(text: string, path: string): NoteMeta {
  const fm = detectFrontMatter(text);
  let fmTitle: string | null = null;
  let tags: readonly string[] = [];
  let date: string | null = null;
  let error: { line: number } | null = null;
  if (fm && !fm.tooLarge) {
    const parsed = parseFrontMatterYaml(text.slice(fm.contentFrom, fm.contentTo));
    if (parsed.ok) ({ title: fmTitle, tags, date } = parsed);
    else error = { line: parsed.line };
  }
  const body = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const title = (fmTitle ?? firstHeading1(body) ?? fileTitle(path)).slice(0, NOTE_TITLE_MAX);
  return error
    ? { title, tags, date, fmError: true, fmErrorLine: error.line }
    : { title, tags, date, fmError: false };
}

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
}

/**
 * Extrator do índice do vault (arch-backend r7 §1.7.5): `meta` barato e síncrono (o de r2) e
 * `start` para o trabalho fatiável (um parse Lezer com wikilinks: links, tarefas e tags do corpo;
 * mais as propriedades do front matter).
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
 * Propriedades do front matter para o índice (R-I9.3): ≤ 100 chaves, chave ≤ 200 caracteres
 * (mais longa é pulada), valores dentro de 1 KiB. Front matter inválido ou grande demais → nada.
 */
export function indexProperties(raw: string): IndexProperties {
  const properties = Object.create(null) as Record<string, IndexPropertyValue>;
  const fm = detectFrontMatter(raw);
  if (!fm || fm.tooLarge) return { properties, truncated: false };
  const parsed = parseFrontMatterYaml(raw.slice(fm.contentFrom, fm.contentTo));
  if (!parsed.ok) return { properties, truncated: false };
  let truncated = false;
  let count = 0;
  for (const { key, value } of parsed.properties) {
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
const TAG_HINT = new RegExp(`(?:^|\\s)${TAG_NAME_SOURCE}`, 'u');
const BODY_TAGS = new RegExp(`(^|\\s)(${TAG_NAME_SOURCE})`, 'gu');

/**
 * Trabalho do índice v3 de uma nota: links (S2) + tarefas pelos nós `Task` da MESMA árvore, com o
 * parser de linha único (`tasks/line.ts`), tags do corpo fora de {@link NO_TAGS} e propriedades.
 */
export function startNoteIndexJob(raw: string, path: string): NoteExtractionJob {
  const text = editorText(raw);
  const wantsTree = TASK_HINT.test(text) || TAG_HINT.test(text);
  const tasks: ParsedTask[] = [];
  let tasksOver = false;
  /** Trechos sem tags, em ordem e sem sobreposição (o percurso não desce neles). */
  const excluded: number[] = [];
  let lineStarts: number[] | null = null;
  let lastTaskLine = -1;

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

  const visit = (c: TreeCursor) => {
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

  const links = startLinkExtraction(raw, path, wantsTree ? visit : undefined);
  let props: IndexProperties | null = null;

  const inlineTags = (): { tags: string[]; over: boolean } => {
    const tags: string[] = [];
    if (!wantsTree) return { tags, over: false };
    let k = 0;
    for (const m of text.matchAll(BODY_TAGS)) {
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
      props ??= indexProperties(raw);
      return links.step(budgetMs);
    },
    result() {
      props ??= indexProperties(raw);
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
  };
}

export function createNoteExtractor(): NoteExtractor {
  return { meta: extractNoteMeta, start: startNoteIndexJob };
}
