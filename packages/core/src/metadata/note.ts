import { markdownLanguage } from '@codemirror/lang-markdown';
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
 * Primeiro H1 (ATX ou setext) fora de código e do front matter, ou `null`. `text` já no formato do
 * editor (sem BOM, só `\n`).
 */
export function firstHeading1(text: string): string | null {
  let found: string | null = null;
  parser.parse(text).iterate({
    enter(node) {
      if (found !== null || NO_HEADING_BLOCKS[node.name]) return false;
      if (headingLevel(node.name) === 1) {
        found = headingText(text.slice(node.from, node.to), node.name);
        return false;
      }
      return undefined;
    },
  });
  return found || null;
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
