import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState, type Range, type Text } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { editorFocusField, isTouched } from './focus';

export type TableAlign = 'left' | 'center' | 'right' | null;

export interface TableCell {
  text: string;
  /** Posição do conteúdo da célula relativa ao início da tabela (clique → cursor na fonte). */
  offset: number;
}

export interface TableModel {
  /** Texto-fonte da tabela, de `from` até o fim da última linha. */
  source: string;
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
 * Modelo da tabela a partir só do texto do documento: cabeçalho, linha de alinhamento e corpo
 * (`TableHeader`, `TableDelimiter` de linha, `TableRow`). Linhas do corpo têm sempre o número de
 * colunas do cabeçalho (GFM: faltantes ficam vazias, excedentes são ignoradas).
 */
export function tableModel(doc: Text, table: SyntaxNode): TableModel {
  const from = doc.lineAt(table.from).from;
  const rowCells = (node: SyntaxNode): TableCell[] => {
    const line = doc.lineAt(node.from);
    return splitRow(line.text, line.from - from);
  };
  let header: TableCell[] = [];
  let align: TableAlign[] = [];
  const rows: TableCell[][] = [];
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableHeader') header = rowCells(child);
    else if (child.name === 'TableRow') rows.push(rowCells(child));
    else if (child.name === 'TableDelimiter')
      align = rowCells(child).map((c) => alignmentOf(c.text));
  }
  const lastLine = doc.lineAt(table.to);
  return {
    source: doc.sliceString(from, lastLine.to),
    header,
    align: header.map((_, i) => align[i] ?? null),
    // Célula faltante: vazia, apontando para a última célula existente da linha.
    rows: rows.map((row) =>
      header.map((_, i) => row[i] ?? { text: '', offset: row.at(-1)?.offset ?? 0 }),
    ),
  };
}

/**
 * `<table>` renderizada no lugar da fonte (AC-3.7). Conteúdo só por `textContent`, nunca
 * `innerHTML`: texto do documento não injeta HTML. `eq` compara a fonte, então tabelas que não
 * mudaram mantêm o DOM; offsets são relativos, então a mesma DOM continua certa se a tabela andar.
 */
export class TableWidget extends WidgetType {
  constructor(readonly model: TableModel) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return other.model.source === this.model.source;
  }

  override get estimatedHeight(): number {
    return (this.model.rows.length + 1) * ESTIMATED_ROW_PX;
  }

  toDOM(): HTMLElement {
    const { header, align, rows } = this.model;
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
export function isTopLevel(node: SyntaxNode): boolean {
  return node.parent?.parent === null;
}

/**
 * Decorações de bloco (tabelas): função pura do `EditorState`. Percorre só os filhos diretos do
 * nó raiz, O(blocos de topo). Uma tabela tocada pela seleção (com foco) fica como fonte crua.
 */
export function computeBlockDecorations(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== 'Table' || isTouched(state, node.from, node.to)) continue;
    const model = tableModel(doc, node);
    const from = doc.lineAt(node.from).from;
    out.push(
      Decoration.replace({ block: true, widget: new TableWidget(model) }).range(
        from,
        from + model.source.length,
      ),
    );
  }
  return Decoration.set(out);
}

export const tablePreviewField = StateField.define<DecorationSet>({
  create: computeBlockDecorations,
  update(decorations, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.startState.field(editorFocusField, false) !== tr.state.field(editorFocusField, false) ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state)
    ) {
      return computeBlockDecorations(tr.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

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
