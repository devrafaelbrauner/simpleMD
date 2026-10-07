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
 */
export function firstHeading1(text: string): string | null {
  if (!/#(?:[ \t\n]|$)|=[ \t]*(?:\n|$)/.test(text)) return null;
  let fragments: readonly TreeFragment[] = [];
  let upto = Math.min(FIRST_WINDOW, text.length);
  for (;;) {
    const parse = parser.startParse(text, fragments);
    if (upto < text.length) parse.stopAt(upto);
    let tree: Tree | null = null;
    while (!tree) tree = parse.advance();
    headingParseCounts.chars += tree.length;
    const complete = upto >= text.length || tree.length >= text.length;
    const found = heading1In(tree, text, complete ? null : upto);
    if (found !== undefined) return found;
    const overran = (tree.topNode.lastChild?.to ?? 0) > upto;
    upto = overran ? text.length : Math.min(upto * 4, text.length);
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
