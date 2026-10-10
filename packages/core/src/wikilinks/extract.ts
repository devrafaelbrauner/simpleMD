import { markdownLanguage } from '@codemirror/lang-markdown';
import type { PartialParse, Tree, TreeCursor } from '@lezer/common';
import type { MarkdownParser } from '@lezer/markdown';
import { frontMatterSyntax } from '../frontmatter/lezer';
import { classifyHref } from '../links/target';
import { refKey, stripAngle } from '../live-preview/references';
import { extendedTaskList } from '../tasks/syntax';
import { readWikilink } from './parse';
import { wikiLinkSyntax } from './syntax';

/** Links de saída guardados por nota no índice (R-I2.8): os excedentes não entram. */
export const NOTE_LINKS_MAX = 1000;

/**
 * Um link de saída (arch-backend r7 §1.7.2): posição 0-based em unidades UTF-16 no texto do editor
 * (sem BOM, só `\n`). `wikilink` guarda o alvo cru (sem apelido nem `#título`); `inline` e
 * `reference` guardam o caminho do vault já resolvido e decodificado (só links `.md`).
 */
export interface ExtractedLink {
  readonly line: number;
  readonly column: number;
  readonly length: number;
  readonly kind: 'wikilink' | 'inline' | 'reference';
  readonly target: string;
}

export interface LinkExtraction {
  readonly links: readonly ExtractedLink[];
  /** Havia mais que {@link NOTE_LINKS_MAX} links (aviso LNK-LIMIT). */
  readonly truncated: boolean;
}

/** Trabalho fatiável (D-R7-B12b): `step` devolve `true` quando terminou. */
export interface LinkExtractionJob {
  step(budgetMs: number): boolean;
  result(): LinkExtraction;
}

/** O MESMO Markdown do editor (GFM, front matter, tarefas estendidas, wikilinks). */
export const linkParser = (markdownLanguage.parser as MarkdownParser).configure([
  frontMatterSyntax,
  extendedTaskList,
  wikiLinkSyntax,
]);

/** Nós sem links: nem o cursor desce neles. */
const NO_LINKS: Record<string, true> = {
  FrontMatter: true,
  FencedCode: true,
  CodeBlock: true,
  InlineCode: true,
  HTMLBlock: true,
  CommentBlock: true,
  ProcessingInstructionBlock: true,
  LinkReference: true,
  Image: true,
  Autolink: true,
};

/** Texto no formato do editor: sem BOM, só `\n` (as linhas do índice são as do editor). */
export function editorText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/**
 * Nó visitado no MESMO percurso dos links (índice v3, S9: tarefas e tags do corpo), na ordem do
 * documento; os nós sem links aparecem, mas o percurso não desce neles.
 */
export type ExtractionVisitor = (node: TreeCursor) => void;

/**
 * Começa a extração dos links de saída de uma nota (`notePath` = caminho no vault, base dos links
 * relativos). Parse Lezer incremental (`advance()`), depois um percurso retomável da árvore; cada
 * `step` respeita o orçamento em milissegundos (8 ms por fatia no índice; NFR-27). Com `visitor`,
 * a nota é sempre analisada e o percurso vai até o fim mesmo depois do teto de links (o
 * `visitor` recebe cada nó; uma análise só para links, tarefas e tags).
 */
export function startLinkExtraction(
  raw: string,
  notePath: string,
  visitor?: ExtractionVisitor,
): LinkExtractionJob {
  const text = editorText(raw);
  // Sem `[[`, `](` nem `]:` não há link possível (CommonMark: o destino vem colado ao `]` e a
  // referência exige a definição `[r]:`): a nota nem é analisada. Mantém o NFR-27 (o r2 só lia o
  // título; a análise completa de 2.000 notas sem links custava ~0,5 s a mais).
  if (!visitor && !text.includes('[[') && !text.includes('](') && !text.includes(']:'))
    return { step: () => true, result: () => ({ links: [], truncated: false }) };
  const links: ExtractedLink[] = [];
  let truncated = false;
  let parse: PartialParse | null = linkParser.startParse(text);
  let tree: Tree | null = null;
  let cursor: TreeCursor | null = null;
  let finished = false;
  let refs: Map<string, string> | null = null;
  let lineStarts: number[] | null = null;

  const position = (pos: number): { line: number; column: number } => {
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
    return { line: lo, column: pos - (lineStarts[lo] as number) };
  };

  const push = (from: number, to: number, kind: ExtractedLink['kind'], target: string) => {
    if (links.length >= NOTE_LINKS_MAX) {
      truncated = true;
      return;
    }
    links.push({ ...position(from), length: to - from, kind, target });
  };

  /** Definições `[r]: url` de topo (mesma `refKey` do editor e da exportação). */
  const definitions = (done: Tree): Map<string, string> => {
    const map = new Map<string, string>();
    for (let node = done.topNode.firstChild; node; node = node.nextSibling) {
      if (node.name !== 'LinkReference') continue;
      const label = node.getChild('LinkLabel');
      const url = node.getChild('URL');
      if (!label || !url) continue;
      const key = refKey(text.slice(label.from + 1, label.to - 1));
      if (!map.has(key)) map.set(key, stripAngle(text.slice(url.from, url.to)));
    }
    return map;
  };

  const mdLink = (c: TreeCursor, defs: ReadonlyMap<string, string>) => {
    const node = c.node;
    if (text[node.from] !== '[') return;
    const close = node.getChildren('LinkMark').find((m) => text[m.from] === ']');
    if (!close) return;
    const url = node.getChildren('URL').find((u) => u.from >= close.to);
    let raw: string | undefined;
    let kind: ExtractedLink['kind'] = 'inline';
    if (url) raw = stripAngle(text.slice(url.from, url.to));
    else {
      const label = node.getChildren('LinkLabel').find((l) => l.from >= close.to);
      const key =
        label && label.to - label.from > 2
          ? text.slice(label.from + 1, label.to - 1)
          : text.slice(node.from + 1, close.from);
      raw = defs.get(refKey(key));
      kind = 'reference';
    }
    if (raw === undefined) return;
    const target = classifyHref(raw.trim(), notePath);
    if (target.kind === 'note') push(node.from, node.to, kind, target.path);
  };

  const walk = (deadline: number): boolean => {
    if (!tree) return false;
    if (!cursor) cursor = tree.cursor();
    refs ??= definitions(tree);
    const c = cursor;
    for (let n = 0; ; n++) {
      if (truncated && !visitor) return true;
      if ((n & 63) === 63 && performance.now() > deadline) return false;
      const name = c.name;
      visitor?.(c);
      let descend = true;
      if (NO_LINKS[name]) descend = false;
      else if (name === 'WikiLink') {
        descend = false;
        const info = readWikilink(c.node, text);
        if (info.target !== '') push(info.from, info.to, 'wikilink', info.target);
      } else if (name === 'Link') {
        descend = false;
        mdLink(c, refs);
      }
      if (!c.next(descend)) return true;
    }
  };

  return {
    step(budgetMs) {
      if (finished) return true;
      const deadline = performance.now() + budgetMs;
      while (parse) {
        const done = parse.advance();
        if (done) {
          tree = done;
          parse = null;
        } else if (performance.now() > deadline) return false;
      }
      finished = walk(deadline);
      return finished;
    },
    result: () => ({ links, truncated }),
  };
}

/** Extração síncrona completa (testes e chamadas sem orçamento). */
export function extractLinks(text: string, notePath: string): LinkExtraction {
  const job = startLinkExtraction(text, notePath);
  while (!job.step(Number.POSITIVE_INFINITY));
  return job.result();
}
