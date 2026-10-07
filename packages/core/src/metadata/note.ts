import { markdownLanguage } from '@codemirror/lang-markdown';
import { TreeFragment, type Tree } from '@lezer/common';
import type { MarkdownParser } from '@lezer/markdown';
import { detectFrontMatter } from '../frontmatter/detect';
import { frontMatterSyntax } from '../frontmatter/lezer';
import { headingLevel, headingText, NO_HEADING_BLOCKS } from './heading';
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
 * Espião do PERF-R2-01: caracteres novos que `firstHeading1` mandou o parser cobrir (cada janela
 * conta só o trecho além da anterior, que vem da árvore reaproveitada). Os testes conferem que uma
 * nota longa com H1 no início não é analisada inteira a cada gravação.
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
 */
export function firstHeading1(text: string): string | null {
  if (!/#(?:[ \t\n]|$)|=[ \t]*(?:\n|$)/.test(text)) return null;
  let fragments: readonly TreeFragment[] = [];
  let covered = 0;
  for (let upto = FIRST_WINDOW; ; upto *= 4) {
    const whole = upto >= text.length;
    const parse = parser.startParse(text, fragments);
    if (!whole) parse.stopAt(upto);
    const end = whole ? text.length : upto;
    headingParseCounts.chars += end - covered;
    covered = end;
    let tree: Tree | null = null;
    while (!tree) tree = parse.advance();
    const found = heading1In(tree, text, whole ? null : upto);
    if (found !== undefined) return found;
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
