import { markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode, Tree } from '@lezer/common';
import type { MarkdownParser } from '@lezer/markdown';
import { detectFrontMatter } from '../frontmatter/detect';
import { frontMatterSyntax } from '../frontmatter/lezer';
import { headingLevel } from '../metadata/heading';
import { parseFrontMatterYaml } from '../metadata/yaml';
import { escapeHtml, htmlImageSources, isUnsafeRender, safeUrl } from './escape';
import { resolveVaultPath } from '../links/vault-path';
import { inlineHtmlGroups } from '../live-preview/html';
import { refKey } from '../live-preview/references';
import { imageSourceCandidate } from '../sanitize/policy';
import type { HtmlSanitizer } from '../sanitize/sanitizer';
import { extendedTaskList } from '../tasks/syntax';

/** Intervalo `[from, to)` relativo ao texto passado ao renderizador. */
export interface ExportSpan {
  readonly from: number;
  readonly to: number;
}

/** Trecho em linha trocado por um renderizador (fórmula KaTeX, resultado do calc). */
export interface ExportSegment extends ExportSpan {
  readonly html: string;
  /** Saída do KaTeX: o arquivo HTML precisa do CSS e das fontes do KaTeX. */
  readonly math: boolean;
}

/**
 * Renderizadores injetados pelo app (arch-frontend r2 §10.2): só os dos plugins internos LIGADOS
 * (desligado → o conteúdo sai cru, como no editor; R-10.4). O core não importa nenhum plugin.
 */
export interface ExportRenderers {
  /** Cerca de código de topo, fechada (Mermaid → `<figure class="smd-mermaid"><svg…>`). */
  fence?(info: string, code: string): Promise<{ readonly html: string } | null>;
  /** Trechos em linha do texto de um bloco, fora de `blocked` (código em linha). */
  inline?(text: string, blocked: readonly ExportSpan[]): readonly ExportSegment[];
  /** Bloco `$$` no início do texto de um parágrafo de topo; `end` = fim do bloco nesse texto. */
  block?(text: string): Promise<{ readonly html: string; readonly end: number } | null>;
}

export type ExportMode = 'file' | 'print';

export interface ExportBody {
  readonly bodyHtml: string;
  /** Alguma fórmula foi renderizada (CSS e fontes do KaTeX só nesse caso; AC-10.5). */
  readonly usesMath: boolean;
}

/**
 * HTML cru na exportação (I-10, R-I10.4; JEV D-R7-S10-01): a política única (`policy`, o mesmo
 * sanitizador do editor) e, depois dela, o pós-checagem DOM do app (`normalize`, CR3-B1; `null` =
 * recusa). O core ainda aplica `isUnsafeRender`. Sem sanitizador, o HTML cru sai como texto (r2).
 */
export interface ExportSanitizer {
  readonly policy: HtmlSanitizer;
  readonly normalize: (html: string) => string | null;
}

/** O mesmo Markdown do editor (GFM + nó `FrontMatter`): exportação = semântica do editor (FR-9). */
const parser = (markdownLanguage.parser as MarkdownParser).configure([
  frontMatterSyntax,
  extendedTaskList,
]);

/** Marcas de sintaxe: nunca viram texto. */
const MARKS: Record<string, true> = {
  HeaderMark: true,
  QuoteMark: true,
  ListMark: true,
  EmphasisMark: true,
  CodeMark: true,
  LinkMark: true,
  StrikethroughMark: true,
  TableDelimiter: true,
  TaskMarker: true,
};

const RAW_BLOCKS: Record<string, true> = {
  HTMLBlock: true,
  CommentBlock: true,
  ProcessingInstructionBlock: true,
};

const ENTITY = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});$/;
const LANG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

type Align = 'left' | 'center' | 'right' | null;

class Serializer {
  usesMath = false;
  readonly #refs = new Map<string, string>();
  /**
   * Marca aleatória por exportação para o `src` das imagens do vault dentro do HTML cru: o
   * pós-checagem vê um relativo inofensivo (`#smd-img-<marca>-<n>`) e só depois ele vira o
   * `data:`/`blob:` do mapa. Texto da nota não adivinha a marca.
   */
  readonly #nonce = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) =>
    n.toString(16).padStart(8, '0'),
  ).join('');

  constructor(
    readonly doc: string,
    readonly tree: Tree,
    readonly renderers: ExportRenderers,
    readonly mode: ExportMode,
    readonly images: ExportImages | null,
    readonly sanitizer: ExportSanitizer | null = null,
  ) {
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
      if (node.name !== 'LinkReference') continue;
      const label = node.getChild('LinkLabel');
      const url = node.getChild('URL');
      if (label && url) {
        const key = refKey(this.text(label).slice(1, -1));
        if (!this.#refs.has(key)) this.#refs.set(key, this.url(url));
      }
    }
  }

  text(node: { from: number; to: number }): string {
    return this.doc.slice(node.from, node.to);
  }

  /** Destino de link sem os `<>` opcionais. */
  url(node: SyntaxNode): string {
    const raw = this.text(node);
    return raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
  }

  /** Saída de renderizador com script/`on*`/URL insegura é descartada (defesa em profundidade). */
  safe(html: string | undefined): html is string {
    return html !== undefined && !isUnsafeRender(html);
  }

  /**
   * HTML cru pela política única e pelo pós-checagem (R-I10.4): `''` = nada exibível sobrou (o
   * bloco some; JEV D-R7-S10-03); `null` = o pós-checagem recusou (quem chama mostra a fonte
   * escapada, como no r2). Imagens do vault: só as do mapa, pela marca (§5 do product).
   */
  html(raw: string): string | null {
    const sanitizer = this.sanitizer;
    if (!sanitizer) return null;
    const sources: string[] = [];
    const html = sanitizer.policy.toExportHtml(raw, (src) => {
      const resolved = this.images ? resolveVaultPath(src.trim(), this.images.notePath) : null;
      const image = resolved?.ok ? this.images?.map.get(resolved.path) : undefined;
      if (!image || !('src' in image)) return null;
      sources.push(image.src);
      return `#smd-img-${this.#nonce}-${sources.length - 1}`;
    });
    if (html === '') return '';
    const checked = sanitizer.normalize(html);
    if (checked === null || !this.safe(checked)) return null;
    return checked.replace(
      new RegExp(`#smd-img-${this.#nonce}-(\\d+)`, 'g'),
      (_, index: string) => escapeHtml(sources[Number(index)] ?? ''),
    );
  }

  async blocks(parent: SyntaxNode, top: boolean): Promise<string> {
    const out: string[] = [];
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      const html = await this.block(node, top);
      if (html !== '') out.push(html);
    }
    return out.join('\n');
  }

  async block(node: SyntaxNode, top: boolean): Promise<string> {
    const level = headingLevel(node.name);
    if (level !== null) return `<h${level}>${this.heading(node)}</h${level}>`;
    if (node.name === 'HTMLBlock' && this.sanitizer) {
      const html = this.html(this.text(node));
      return html ?? `<p class="smd-raw">${escapeHtml(this.text(node))}</p>`;
    }
    if (RAW_BLOCKS[node.name]) return `<p class="smd-raw">${escapeHtml(this.text(node))}</p>`;
    switch (node.name) {
      case 'FrontMatter':
      case 'LinkReference':
        return '';
      case 'Paragraph':
        return this.paragraph(node, top);
      case 'BulletList':
        return `<ul>\n${await this.items(node)}\n</ul>`;
      case 'OrderedList': {
        const mark = node.firstChild?.getChild('ListMark');
        const start = mark ? Number.parseInt(this.text(mark), 10) : 1;
        const attr = Number.isFinite(start) && start !== 1 ? ` start="${start}"` : '';
        return `<ol${attr}>\n${await this.items(node)}\n</ol>`;
      }
      case 'Blockquote':
        return `<blockquote>\n${await this.blocks(node, false)}\n</blockquote>`;
      case 'FencedCode':
        return this.fenced(node, top);
      case 'CodeBlock':
        return this.indented(node);
      case 'HorizontalRule':
        return '<hr>';
      case 'Table':
        return this.table(node);
      default:
        return MARKS[node.name] ? '' : `<p>${escapeHtml(this.text(node))}</p>`;
    }
  }

  heading(node: SyntaxNode): string {
    let from = node.from;
    let to = node.to;
    const marks = node.getChildren('HeaderMark');
    if (node.name.startsWith('Setext')) {
      const underline = marks[marks.length - 1];
      if (underline) to = underline.from;
    } else {
      const open = marks[0];
      if (open) from = open.to;
      const close = marks.length > 1 ? marks[marks.length - 1] : undefined;
      if (close && close.from > from) to = close.from;
    }
    while (from < to && /\s/.test(this.doc[from] ?? '')) from++;
    while (to > from && /\s/.test(this.doc[to - 1] ?? '')) to--;
    return this.container(node, from, to);
  }

  async paragraph(node: SyntaxNode, top: boolean, wrap = true): Promise<string> {
    const text = this.text(node);
    if (top && this.renderers.block && text.startsWith('$$')) {
      const math = await this.renderers.block(text);
      if (math && this.safe(math.html)) {
        this.usesMath = true;
        let rest = node.from + math.end;
        if (this.doc[rest] === '\n') rest++;
        const tail = rest < node.to ? this.container(node, rest, node.to).trim() : '';
        return tail === '' ? math.html : `${math.html}\n<p>${tail}</p>`;
      }
    }
    const html = this.container(node, node.from, node.to);
    return wrap ? `<p>${html}</p>` : html;
  }

  /** Itens de lista: numa lista "apertada" (sem linha em branco) o parágrafo único sai sem `<p>`. */
  async items(list: SyntaxNode): Promise<string> {
    const loose = /\n[ \t]*\n/.test(this.text(list).trimEnd());
    const out: string[] = [];
    for (let item = list.firstChild; item; item = item.nextSibling) {
      if (item.name !== 'ListItem') continue;
      const parts: string[] = [];
      for (let child = item.firstChild; child; child = child.nextSibling) {
        if (child.name === 'Task') parts.push(this.task(child));
        else if (child.name === 'Paragraph' && !loose)
          parts.push(await this.paragraph(child, false, false));
        else {
          const html = await this.block(child, false);
          if (html !== '') parts.push(html);
        }
      }
      out.push(`<li>${parts.join('\n')}</li>`);
    }
    return out.join('\n');
  }

  task(node: SyntaxNode): string {
    const marker = node.getChild('TaskMarker');
    const checked = marker ? /x/i.test(this.text(marker)) : false;
    const from = marker ? marker.to : node.from;
    const body = this.container(node, from, node.to).trim();
    return `<span class="smd-task">${checked ? '☑' : '☐'}</span> ${body}`;
  }

  async fenced(node: SyntaxNode, top: boolean): Promise<string> {
    const infoNode = node.getChild('CodeInfo');
    const info = infoNode ? this.text(infoNode).trim() : '';
    const codeNode = node.getChild('CodeText');
    const code = codeNode ? this.text(codeNode) : '';
    const closed = node.getChildren('CodeMark').length >= 2;
    if (top && closed && this.renderers.fence) {
      const rendered = await this.renderers.fence(info, code);
      if (rendered && this.safe(rendered.html)) return rendered.html;
    }
    const lang = info.split(/\s/)[0] ?? '';
    const attr = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
    return `<pre><code${attr}>${escapeHtml(code)}</code></pre>`;
  }

  indented(node: SyntaxNode): string {
    const lineStart = this.doc.lastIndexOf('\n', node.from - 1) + 1;
    const code = this.doc
      .slice(lineStart, node.to)
      .split('\n')
      .map((line) => line.replace(/^(?: {1,4}|\t)/, ''))
      .join('\n');
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }

  table(node: SyntaxNode): string {
    const delimiter = node.getChildren('TableDelimiter')[0];
    const aligns: Align[] = delimiter
      ? this.cells(this.text(delimiter)).map((cell) => {
          const left = cell.startsWith(':');
          const right = cell.endsWith(':');
          if (left && right) return 'center';
          if (right) return 'right';
          return left ? 'left' : null;
        })
      : [];
    const header = node.getChild('TableHeader');
    const head = header ? this.rowCells(header) : [];
    const columns = head.length;
    const attr = (i: number) => (aligns[i] ? ` style="text-align: ${aligns[i]}"` : '');
    const rows = node
      .getChildren('TableRow')
      .map((row) => {
        const cells = this.rowCells(row);
        const tds = Array.from(
          { length: columns },
          (_, i) => `<td${attr(i)}>${cells[i] ?? ''}</td>`,
        ).join('');
        return `<tr>${tds}</tr>`;
      })
      .join('\n');
    const ths = head.map((cell, i) => `<th scope="col"${attr(i)}>${cell}</th>`).join('');
    const body = rows === '' ? '' : `\n<tbody>\n${rows}\n</tbody>`;
    return `<table>\n<thead><tr>${ths}</tr></thead>${body}\n</table>`;
  }

  /** Células de texto separadas por `|` (linha delimitadora), sem os pipes das bordas. */
  cells(line: string): string[] {
    const parts = line.trim().split('|');
    if (parts[0]?.trim() === '') parts.shift();
    if (parts.length > 0 && parts[parts.length - 1]?.trim() === '') parts.pop();
    return parts.map((part) => part.trim());
  }

  /**
   * Células de uma linha da tabela pelos pipes (`TableDelimiter`), para que uma célula vazia (sem
   * nó `TableCell`) não desloque as colunas.
   */
  rowCells(row: SyntaxNode): string[] {
    const pipes = row.getChildren('TableDelimiter');
    const bounds: Array<[number, number]> = [];
    let start = row.from;
    for (const pipe of pipes) {
      bounds.push([start, pipe.from]);
      start = pipe.to;
    }
    bounds.push([start, row.to]);
    const blank = ([a, b]: [number, number]) => this.doc.slice(a, b).trim() === '';
    if (bounds.length > 1 && blank(bounds[0] as [number, number])) bounds.shift();
    if (bounds.length > 1 && blank(bounds[bounds.length - 1] as [number, number])) bounds.pop();
    const cells = row.getChildren('TableCell');
    return bounds.map(([a, b]) => {
      const cell = cells.find((c) => c.from >= a && c.to <= b);
      return cell ? this.container(cell, cell.from, cell.to).trim() : '';
    });
  }

  /**
   * Conteúdo em linha de um bloco (`[from, to)` dentro de `node`): primeiro os trechos dos
   * renderizadores sobre o texto inteiro do bloco (fora do código em linha), depois a árvore.
   */
  container(node: SyntaxNode, from: number, to: number): string {
    let segments: ExportSegment[] = [];
    const inline = this.renderers.inline;
    if (inline && from < to) {
      const blocked: ExportSpan[] = [];
      const cursor = node.cursor();
      cursor.iterate((n) => {
        if (n.to <= from || n.from >= to) return false;
        if (n.name === 'InlineCode') {
          blocked.push({ from: n.from - from, to: n.to - from });
          return false;
        }
        return undefined;
      });
      segments = inline(this.doc.slice(from, to), blocked)
        .filter((s) => this.safe(s.html))
        .map((s) => ({ ...s, from: s.from + from, to: s.to + from }));
      if (segments.some((s) => s.math)) this.usesMath = true;
    }
    return this.range(node, from, to, segments);
  }

  /**
   * `[from, to)` de `parent`: texto escapado, filhos em linha e trechos renderizados. Um trecho que
   * cobre filhos inteiros os substitui; um trecho dentro de um único filho desce até ele; um que
   * corta um filho no meio é descartado (fica o texto).
   */
  range(parent: SyntaxNode, from: number, to: number, segments: readonly ExportSegment[]): string {
    const children: SyntaxNode[] = [];
    for (let c = parent.firstChild; c; c = c.nextSibling) {
      if (c.to > from && c.from < to) children.push(c);
    }
    const here: ExportSegment[] = [];
    const down = new Map<SyntaxNode, ExportSegment[]>();
    for (const s of segments) {
      const hit = children.filter((c) => c.from < s.to && c.to > s.from);
      if (hit.every((c) => c.from >= s.from && c.to <= s.to)) here.push(s);
      else if (hit.length === 1 && hit[0] && hit[0].from <= s.from && hit[0].to >= s.to)
        down.set(hit[0], [...(down.get(hit[0]) ?? []), s]);
    }
    type Item = { from: number; to: number; html: () => string };
    // Tags em linha balanceadas (I-10): o grupo inteiro passa pela política, como no editor.
    const groups = this.sanitizer
      ? inlineHtmlGroups(parent, (a, b) => this.doc.slice(a, b)).filter(
          (g) => g.from >= from && g.to <= to,
        )
      : [];
    const items: Item[] = [
      ...here.map((s) => ({ from: s.from, to: s.to, html: () => s.html })),
      ...groups.map((g) => ({
        from: g.from,
        to: g.to,
        html: () => {
          const raw = this.doc.slice(g.from, g.to);
          return this.html(raw) ?? escapeHtml(raw);
        },
      })),
      ...children
        .filter((c) => !here.some((s) => c.from >= s.from && c.to <= s.to))
        .filter((c) => !groups.some((g) => c.from >= g.from && c.to <= g.to))
        .map((c) => ({
          from: c.from,
          to: c.to,
          html: () => this.inlineNode(c, down.get(c) ?? []),
        })),
    ].sort((a, b) => a.from - b.from);
    let out = '';
    let pos = from;
    for (const item of items) {
      if (item.from < pos) continue;
      out += escapeHtml(this.doc.slice(pos, item.from));
      out += item.html();
      pos = item.to;
    }
    return out + escapeHtml(this.doc.slice(pos, Math.max(pos, to)));
  }

  inlineNode(node: SyntaxNode, segments: readonly ExportSegment[]): string {
    if (MARKS[node.name]) return '';
    switch (node.name) {
      case 'Emphasis':
        return `<em>${this.range(node, node.from, node.to, segments)}</em>`;
      case 'StrongEmphasis':
        return `<strong>${this.range(node, node.from, node.to, segments)}</strong>`;
      case 'Strikethrough':
        return `<del>${this.range(node, node.from, node.to, segments)}</del>`;
      case 'InlineCode': {
        const marks = node.getChildren('CodeMark');
        const open = marks[0];
        const close = marks[marks.length - 1];
        let code =
          open && close && close.from > open.to
            ? this.doc.slice(open.to, close.from)
            : this.text(node);
        if (/^ .*[^ ].* $/s.test(code)) code = code.slice(1, -1);
        return `<code>${escapeHtml(code)}</code>`;
      }
      case 'Link':
        return this.link(node, segments);
      case 'Image':
        return this.image(node);
      case 'Autolink': {
        const urlNode = node.getChild('URL');
        const raw = urlNode ? this.text(urlNode) : this.text(node).slice(1, -1);
        const href = /^[^\s@<>]+@[^\s@<>]+$/.test(raw) ? `mailto:${raw}` : raw;
        return this.anchor(href, escapeHtml(raw));
      }
      case 'URL': {
        const raw = this.text(node);
        return this.anchor(/^www\./i.test(raw) ? `https://${raw}` : raw, escapeHtml(raw));
      }
      case 'Escape':
        return escapeHtml(this.text(node).slice(1));
      case 'Entity': {
        const raw = this.text(node);
        return ENTITY.test(raw) ? raw : escapeHtml(raw);
      }
      case 'HardBreak':
        return '<br>\n';
      default:
        return node.firstChild
          ? this.range(node, node.from, node.to, segments)
          : escapeHtml(this.text(node));
    }
  }

  anchor(href: string, inner: string): string {
    const url = safeUrl(href, 'link');
    return url === null ? inner : `<a href="${escapeHtml(url)}">${inner}</a>`;
  }

  /** `[rótulo](url)`, `[rótulo][ref]` ou `[ref]`. Esquema fora da lista → só o rótulo, como texto. */
  link(node: SyntaxNode, segments: readonly ExportSegment[]): string {
    const marks = node.getChildren('LinkMark');
    const open = marks[0];
    const close = marks.find((m) => this.text(m) === ']');
    if (!open || !close) return escapeHtml(this.text(node));
    const label = this.range(node, open.to, close.from, segments);
    const urlNode = node.getChildren('URL').find((u) => u.from >= close.to);
    let href: string | undefined;
    if (urlNode) href = this.url(urlNode);
    else {
      const ref = node.getChildren('LinkLabel').find((l) => l.from >= close.to);
      const key =
        ref && ref.to - ref.from > 2
          ? this.text(ref).slice(1, -1)
          : this.text(node).slice(1, close.from - node.from);
      href = this.#refs.get(refKey(key));
      if (href === undefined) return `[${label}]${escapeHtml(this.doc.slice(close.to, node.to))}`;
    }
    return this.anchor(href, label);
  }

  /**
   * Imagem (R-10.5, R-I1.7, §5 do product): do vault (destino relativo), o `src` vem só do mapa do
   * app (`data:` no arquivo, `blob:` na impressão; MIME conferido); recusada, fora do mapa ou além
   * do teto → o texto alternativo. Remota: no arquivo, `<img src>` como escrito (esquema na
   * lista); na impressão, o texto alternativo.
   */
  image(node: SyntaxNode): string {
    const marks = node.getChildren('LinkMark');
    const open = marks[0];
    const close = marks.find((m) => this.text(m) === ']');
    const alt = open && close ? this.doc.slice(open.to, close.from) : '';
    const altText = alt === '' ? '' : `<span class="smd-img-alt">${escapeHtml(alt)}</span>`;
    const raw = close ? this.imageDestination(node, close, alt) : undefined;
    const src = raw === undefined ? null : safeUrl(raw, 'image');
    if (src === null) return altText;
    if (!IMAGE_SCHEME.test(src)) {
      const resolved = this.images ? resolveVaultPath(src, this.images.notePath) : null;
      const image = resolved?.ok ? this.images?.map.get(resolved.path) : undefined;
      return image && 'src' in image
        ? `<img src="${escapeHtml(image.src)}" alt="${escapeHtml(alt)}">`
        : altText;
    }
    if (this.mode === 'print') return altText;
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
  }

  /** Destino de `![a](u)` ou de `![a][r]`/`![a][]`/`![a]` pela definição; sem definição → nada. */
  imageDestination(node: SyntaxNode, close: SyntaxNode, alt: string): string | undefined {
    const urlNode = node.getChildren('URL').find((u) => u.from >= close.to);
    if (urlNode) return this.url(urlNode);
    const label = node.getChildren('LinkLabel').find((l) => l.from >= close.to);
    const key = label && label.to - label.from > 2 ? this.text(label).slice(1, -1) : alt;
    return this.#refs.get(refKey(key));
  }
}

/** Esquema no destino (`http:`, `data:`…): não é imagem do vault. */
const IMAGE_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Imagem do vault já lida pelo app: o `src` a usar, ou a recusa (fica o texto alternativo). */
export type ExportImage = { readonly src: string } | { readonly reason: 'refused' | 'over-budget' };

/** Imagens do vault da exportação (D-R7-F18): resolvidas a partir da nota, por caminho no vault. */
export interface ExportImages {
  readonly notePath: string | null;
  readonly map: ReadonlyMap<string, ExportImage>;
}

/**
 * Pré-passada pura (arch-frontend r7 §9): os caminhos no vault das imagens do documento (destino
 * relativo, em linha ou por referência, e `<img src>` relativo do HTML cru, I-10), sem repetição,
 * na ordem em que aparecem (o teto de 50 MiB vale nessa ordem, Q-R7-F06). Esquemas (`https:`,
 * `data:`, `file:`…) e destinos fora do vault ficam de fora.
 */
export function collectExportImages(doc: string, notePath: string | null): string[] {
  const tree = parser.parse(doc);
  const serializer = new Serializer(doc, tree, {}, 'file', null);
  const paths = new Set<string>();
  const add = (raw: string) => {
    const resolved = resolveVaultPath(raw.trim(), notePath);
    if (resolved.ok) paths.add(resolved.path);
  };
  tree.iterate({
    enter: (ref) => {
      if (ref.name === 'HTMLBlock' || ref.name === 'HTMLTag') {
        for (const src of htmlImageSources(serializer.text(ref))) {
          if (imageSourceCandidate(src)) add(src);
        }
        return false;
      }
      if (RAW_BLOCKS[ref.name] || ref.name === 'FencedCode' || ref.name === 'CodeBlock')
        return false;
      if (ref.name !== 'Image') return undefined;
      const node = ref.node;
      const close = node.getChildren('LinkMark').find((m) => serializer.text(m) === ']');
      const open = node.getChildren('LinkMark')[0];
      if (!close || !open) return false;
      const raw = serializer.imageDestination(node, close, doc.slice(open.to, close.from));
      if (raw === undefined || IMAGE_SCHEME.test(raw)) return false;
      add(raw);
      return false;
    },
  });
  return [...paths];
}

/**
 * Corpo HTML da exportação (R-10.4; arch-frontend r2 §10.2): percorre a MESMA árvore Lezer do
 * editor. Todo texto passa por um único escape; HTML cru sai pela política única do I-10 quando o
 * app passa `sanitizer` (senão, como texto visível, D-15); o front matter não sai; links só com
 * esquema permitido; o serializador nunca produz `<script>` nem atributos `on*`, e saídas de
 * renderizador ou do HTML cru com isso são descartadas (fica a fonte, escapada).
 * `doc` é o texto do editor (só `\n`, sem BOM).
 */
export async function renderExportBody(
  doc: string,
  opts: {
    readonly renderers: ExportRenderers;
    readonly mode: ExportMode;
    /** Imagens do vault lidas pelo app (`collectExportImages` → `ExportImageMap`). */
    readonly images: ExportImages;
    /** HTML cru pela política do I-10 (o app sempre passa; R-I10.4). */
    readonly sanitizer?: ExportSanitizer;
  },
): Promise<ExportBody> {
  const serializer = new Serializer(
    doc,
    parser.parse(doc),
    opts.renderers,
    opts.mode,
    opts.images,
    opts.sanitizer ?? null,
  );
  const bodyHtml = await serializer.blocks(serializer.tree.topNode, true);
  return { bodyHtml, usesMath: serializer.usesMath };
}

/** `lang` do front matter (texto BCP 47 plausível), senão `null` (R-10.4: o padrão é pt-BR). */
export function frontMatterLang(doc: string): string | null {
  const fm = detectFrontMatter(doc);
  if (!fm || fm.tooLarge) return null;
  const parsed = parseFrontMatterYaml(doc.slice(fm.contentFrom, fm.contentTo));
  if (!parsed.ok) return null;
  const value = parsed.properties.find((p) => p.key === 'lang')?.value;
  return typeof value === 'string' && LANG.test(value.trim()) ? value.trim() : null;
}

/**
 * CSP do arquivo exportado (APPSEC-R2-09; AC-EX.5): nenhum script nem busca, salvo as imagens como
 * escritas no documento (http/https/relativas, que num arquivo aberto do disco resolvem para
 * `file:`), as imagens do vault embutidas em `data:` (r7, único acréscimo), o `<style>` e os
 * `style=""` embutidos e as fontes do KaTeX em `data:`.
 */
export const EXPORT_CSP =
  "default-src 'none'; img-src * file: data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";

/**
 * Documento autocontido (R-10.4): `<!doctype html>`, `lang`, `charset`, a CSP {@link EXPORT_CSP}
 * (antes de qualquer estilo), `<title>` e UMA folha de estilo embutida. `css` vem do app (tokens
 * claros + export.css + KaTeX quando há fórmula).
 */
export function exportDocument(opts: {
  readonly title: string;
  readonly lang: string;
  readonly css: string;
  readonly bodyHtml: string;
}): string {
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(opts.lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(opts.title)}</title>`,
    `<style>\n${opts.css.replace(/<\/style/gi, '<\\/style')}\n</style>`,
    '</head>',
    '<body class="smd-export-body">',
    '<main class="smd-doc">',
    opts.bodyHtml,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
