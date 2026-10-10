import { markdownLanguage } from '@codemirror/lang-markdown';
import { TreeFragment, type Tree } from '@lezer/common';
import type { MarkdownParser } from '@lezer/markdown';
import { detectFrontMatter } from '../frontmatter/detect';
import { frontMatterSyntax } from '../frontmatter/lezer';
import { startLinkExtraction, type ExtractedLink } from '../wikilinks/extract';
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

/** Dados do índice v2 de uma nota além dos metadados (arch-backend r7 §1.7.4; S9 acrescenta). */
export interface NoteIndexData {
  readonly links: readonly ExtractedLink[];
  /** Tetos atingidos na extração (`links` > 1.000 → aviso LNK-LIMIT). */
  readonly truncated: readonly 'links'[];
}

/** Trabalho fatiável do extrator (D-R7-B12b). */
export interface NoteExtractionJob {
  step(budgetMs: number): boolean;
  result(): NoteIndexData;
}

/**
 * Extrator do índice do vault (arch-backend r7 §1.7.5): `meta` barato e síncrono (o de r2) e
 * `start` para o trabalho fatiável (parse Lezer com wikilinks + links de saída).
 */
export interface NoteExtractor {
  meta(text: string, path: string): NoteMeta;
  start(text: string, path: string): NoteExtractionJob;
}

export function createNoteExtractor(): NoteExtractor {
  return {
    meta: extractNoteMeta,
    start(text, path) {
      const job = startLinkExtraction(text, path);
      return {
        step: (budgetMs) => job.step(budgetMs),
        result() {
          const { links, truncated } = job.result();
          return { links, truncated: truncated ? ['links'] : [] };
        },
      };
    },
  };
}
