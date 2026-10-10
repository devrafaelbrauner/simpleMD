import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { BlockContributor } from './block';
import type { InlineContributor } from './context';

export type TableAlign = 'left' | 'center' | 'right' | null;

export interface TableCell {
  text: string;
  /** Posição do conteúdo da célula relativa ao início da tabela (clique → cursor na fonte). */
  offset: number;
}

export interface TableModel {
  header: TableCell[];
  align: TableAlign[];
  rows: TableCell[][];
}

/** Estimativa de altura de uma linha renderizada da tabela, até o DOM real ser medido. */
const ESTIMATED_ROW_PX = 29;

/** Divide uma linha de tabela GFM em células nos `|` não escapados. */
function splitRow(text: string, base: number): TableCell[] {
  let start = text.search(/\S/);
  if (start < 0) return [];
  let end = text.trimEnd().length;
  if (text[start] === '|') start++;
  if (end > start && text[end - 1] === '|' && text[end - 2] !== '\\') end--;
  const cells: TableCell[] = [];
  let cellStart = start;
  for (let i = start; i <= end; i++) {
    if (i < end && (text[i] !== '|' || text[i - 1] === '\\')) continue;
    const raw = text.slice(cellStart, i);
    const lead = raw.length - raw.trimStart().length;
    cells.push({ text: raw.trim().replace(/\\\|/g, '|'), offset: base + cellStart + lead });
    cellStart = i + 1;
  }
  return cells;
}

function alignmentOf(cell: string): TableAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':') && cell.length > 1;
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return null;
}

/**
 * Modelo da tabela a partir só do texto-fonte (todas as linhas são da tabela: cabeçalho, linha de
 * alinhamento e corpo). Linhas do corpo têm sempre o número de colunas do cabeçalho (GFM: faltantes
 * ficam vazias, excedentes são ignoradas).
 */
export function tableModel(source: string): TableModel {
  const lines = source.split('\n');
  const rowsAt: TableCell[][] = [];
  let base = 0;
  for (const line of lines) {
    rowsAt.push(splitRow(line, base));
    base += line.length + 1;
  }
  const header = rowsAt[0] ?? [];
  const align = (rowsAt[1] ?? []).map((cell) => alignmentOf(cell.text));
  const rows = rowsAt.slice(2);
  return {
    header,
    align: header.map((_, i) => align[i] ?? null),
    // Célula faltante: vazia, apontando para a última célula existente da linha.
    rows: rows.map((row) =>
      header.map((_, i) => row[i] ?? { text: '', offset: row.at(-1)?.offset ?? 0 }),
    ),
  };
}

/**
 * `<table>` renderizada no lugar da fonte (AC-3.7). O modelo é montado no `toDOM` (só tabelas
 * desenhadas pagam; arch-frontend r7 §5.2). Conteúdo só por `textContent`, nunca `innerHTML`.
 * `eq` compara a fonte, então tabelas que não mudaram mantêm o DOM; offsets são relativos, então a
 * mesma DOM continua certa se a tabela andar.
 */
export class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return other.source === this.source;
  }

  override get estimatedHeight(): number {
    // Linhas do texto menos a de alinhamento = cabeçalho + corpo.
    let lines = 0;
    for (let i = this.source.indexOf('\n'); i >= 0; i = this.source.indexOf('\n', i + 1)) lines++;
    return Math.max(lines, 1) * ESTIMATED_ROW_PX;
  }

  toDOM(): HTMLElement {
    const { header, align, rows } = tableModel(this.source);
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table-wrap';
    const table = wrap.appendChild(document.createElement('table'));
    table.className = 'cm-md-table';
    const fill = (cell: HTMLTableCellElement, data: TableCell, column: number) => {
      cell.textContent = data.text;
      cell.dataset.offset = String(data.offset);
      const textAlign = align[column];
      if (textAlign) cell.style.textAlign = textAlign;
    };
    const headRow = table.createTHead().insertRow();
    header.forEach((data, column) => {
      const th = document.createElement('th');
      th.scope = 'col';
      fill(th, data, column);
      headRow.appendChild(th);
    });
    const body = table.createTBody();
    for (const row of rows) {
      const tr = body.insertRow();
      row.forEach((data, column) => fill(tr.insertCell(), data, column));
    }
    return wrap;
  }

  /** O editor recebe só o `mousedown` (tratado em `tableClickHandler`); o resto é do widget. */
  override ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown';
  }
}

/** Só tabelas filhas diretas do documento viram widget (arch-frontend C-1, A-5). */
function isTopLevel(node: SyntaxNode): boolean {
  return node.parent?.parent === null;
}

/**
 * Tabela de topo como widget de bloco (contribuidor do campo de blocos, §5.2): fora do cursor, um
 * `TableWidget` sobre as linhas da tabela; tocada pela seleção (com foco) → fonte crua.
 */
export const tableBlock: BlockContributor = {
  nodes: ['Table'],
  build(node, ctx) {
    if (ctx.isTouched(node.from, node.to)) return null;
    const from = ctx.doc.lineAt(node.from).from;
    const to = ctx.doc.lineAt(node.to).to;
    return Decoration.replace({
      block: true,
      widget: new TableWidget(ctx.doc.sliceString(from, to)),
    }).range(from, to);
  },
};

const tableSourceLine = Decoration.line({ class: 'cm-md-table-src' });

/**
 * Tabela de topo revelada: fonte crua com fundo de bloco. Fora disso, o widget vem do campo de
 * blocos. Tabelas aninhadas em listas/citações ficam cruas (MELHORIAS). Não desce.
 */
export const tableSource: InlineContributor = {
  nodes: ['Table'],
  enter(node, ctx) {
    if (isTopLevel(node) && ctx.isTouched(node.from, node.to))
      ctx.blockLines(node, tableSourceLine);
    return false;
  },
};

/**
 * Clique numa tabela renderizada: cursor no texto-fonte da célula clicada (ou no início da
 * tabela), foco no editor; a tabela tocada passa a mostrar a fonte crua (R-3.2, AC-3.7).
 */
export const tableClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as Element | null;
    const wrap = target?.closest?.('.cm-md-table-wrap');
    if (!wrap || !view.contentDOM.contains(wrap)) return false;
    const start = view.posAtDOM(wrap);
    const cell = target?.closest<HTMLElement>('[data-offset]');
    const anchor = Math.min(start + Number(cell?.dataset.offset ?? 0), view.state.doc.length);
    event.preventDefault();
    view.dispatch({ selection: { anchor } });
    view.focus();
    return true;
  },
});
