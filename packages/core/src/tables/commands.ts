import { isolateHistory } from '@codemirror/commands';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { Facet, Transaction, type EditorState, type StateEffect } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { Focus, Table, TableRow } from '@tgrosinger/md-advanced-tables';
import { StateTextEditor, type EditorSnapshot } from './adapter';
import {
  loadTableEngine,
  tableEngine,
  tableOptions,
  type TableEngine,
  type TableOptions,
} from './engine';

/**
 * Comandos "Tabela: …" (R-I3.1, arch-ux §3.7, STR-154 vinculante). Ids da paleta = `table:<id>`.
 * Atalhos (UX-R7-D7/D20): só "Formatar tabela" tem atalho de comando (`Mod-Shift-F`); próxima/
 * anterior célula usam a Classe B `Mod-Alt-→/←` da cadeia e "Próxima linha" é o Enter na tabela.
 */
export type TableCommandId =
  | 'format'
  | 'format-all'
  | 'next-cell'
  | 'prev-cell'
  | 'next-row'
  | 'insert-row-above'
  | 'insert-row-below'
  | 'delete-row'
  | 'insert-col-left'
  | 'insert-col-right'
  | 'delete-col'
  | 'move-row-up'
  | 'move-row-down'
  | 'move-col-left'
  | 'move-col-right'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'align-none'
  | 'sort-asc'
  | 'sort-desc'
  | 'transpose';

export interface TableCommandSpec {
  readonly id: TableCommandId;
  readonly title: string;
  /** Tecla ligada no editor (notação do CM), mostrada na paleta. */
  readonly hotkey?: string;
}

/** Os 22 comandos, na ordem da paleta (arch-ux §3.7). */
export const TABLE_COMMANDS: readonly TableCommandSpec[] = [
  { id: 'format', title: 'Tabela: Formatar tabela', hotkey: 'Mod-Shift-f' },
  { id: 'format-all', title: 'Tabela: Formatar todas as tabelas' },
  { id: 'next-cell', title: 'Tabela: Próxima célula', hotkey: 'Mod-Alt-ArrowRight' },
  { id: 'prev-cell', title: 'Tabela: Célula anterior', hotkey: 'Mod-Alt-ArrowLeft' },
  { id: 'next-row', title: 'Tabela: Próxima linha', hotkey: 'Enter' },
  { id: 'insert-row-above', title: 'Tabela: Inserir linha acima' },
  { id: 'insert-row-below', title: 'Tabela: Inserir linha abaixo' },
  { id: 'delete-row', title: 'Tabela: Excluir linha' },
  { id: 'insert-col-left', title: 'Tabela: Inserir coluna à esquerda' },
  { id: 'insert-col-right', title: 'Tabela: Inserir coluna à direita' },
  { id: 'delete-col', title: 'Tabela: Excluir coluna' },
  { id: 'move-row-up', title: 'Tabela: Mover linha acima' },
  { id: 'move-row-down', title: 'Tabela: Mover linha abaixo' },
  { id: 'move-col-left', title: 'Tabela: Mover coluna à esquerda' },
  { id: 'move-col-right', title: 'Tabela: Mover coluna à direita' },
  { id: 'align-left', title: 'Tabela: Alinhar coluna à esquerda' },
  { id: 'align-center', title: 'Tabela: Alinhar coluna ao centro' },
  { id: 'align-right', title: 'Tabela: Alinhar coluna à direita' },
  { id: 'align-none', title: 'Tabela: Sem alinhamento' },
  { id: 'sort-asc', title: 'Tabela: Ordenar linhas por esta coluna (crescente)' },
  { id: 'sort-desc', title: 'Tabela: Ordenar linhas por esta coluna (decrescente)' },
  { id: 'transpose', title: 'Tabela: Transpor tabela' },
];

/** Avisos STR-155 (vinculantes) e anúncios STR-156. */
export const TABLE_TEXT = {
  outside: 'Coloque o cursor numa tabela',
  nested: 'Tabelas dentro de listas ou citações não são suportadas',
  created: 'Linha nova criada.',
  header: (column: number) => `Cabeçalho, coluna ${column}`,
  row: (row: number, column: number) => `Linha ${row}, coluna ${column}`,
} as const;

/** Movimentos anunciados pelo editor (Tab, `Mod-Alt-→/←`, Enter; DA-R7-21). */
const ANNOUNCED: Partial<Record<TableCommandId, true>> = {
  'next-cell': true,
  'prev-cell': true,
  'next-row': true,
};

/**
 * Para onde vai o aviso STR-155 (N1 warn): o app provê pela sua lista de serviços do editor. Sem
 * provedor (testes do núcleo, prévia de temas) o comando só não muda nada.
 */
export const tableNoticeFacet = Facet.define<(text: string) => void>();

/** Linhas (a partir de 0) de uma tabela de topo no documento. */
export interface TableRows {
  readonly startRow: number;
  readonly endRow: number;
}

export type TableContext = ({ readonly kind: 'top' } & TableRows) | { readonly kind: 'nested' };

function rowsOf(state: EditorState, node: SyntaxNode): TableRows {
  return {
    startRow: state.doc.lineAt(node.from).number - 1,
    endRow: state.doc.lineAt(node.to).number - 1,
  };
}

/**
 * Tabela GFM na linha de `pos` (R-I3.2): `top` = filha direta do documento (as mesmas que o widget
 * do live preview desenha); `nested` = dentro de lista ou citação; `null` = fora de tabela.
 */
export function tableAt(state: EditorState, pos: number): TableContext | null {
  const line = state.doc.lineAt(pos);
  const tree = ensureSyntaxTree(state, line.to, 50) ?? syntaxTree(state);
  let table: SyntaxNode | null = null;
  tree.iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (table) return false;
      if (node.name !== 'Table') return undefined;
      if (node.from <= line.to && node.to >= line.from) table = node.node;
      return false;
    },
  });
  if (!table) return null;
  const found: SyntaxNode = table;
  return found.parent?.parent === null ? { kind: 'top', ...rowsOf(state, found) } : { kind: 'nested' };
}

/** Todas as tabelas de topo do documento ("Formatar todas as tabelas"). */
function topLevelTables(state: EditorState): TableRows[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const out: TableRows[] = [];
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling)
    if (node.name === 'Table') out.push(rowsOf(state, node));
  return out;
}

function notify(view: EditorView, text: string): void {
  for (const sink of view.state.facet(tableNoticeFacet)) sink(text);
}

/**
 * Linhas GFM sem `|` inicial (`a | b`) são tabelas para o Lezer e para o widget, mas não para o
 * upstream: na MESMA transação, `| ` entra depois da indentação de cada linha (D-R7-S3-06).
 */
function normalizePipes(editor: StateTextEditor, rows: TableRows): void {
  for (let row = rows.startRow; row <= rows.endRow; row++) {
    const text = editor.getLine(row);
    const indent = text.length - text.trimStart().length;
    if (text[indent] !== '|')
      editor.replaceLines(row, row + 1, [`${text.slice(0, indent)}| ${text.slice(indent)}`]);
  }
}

interface Located extends TableRows {
  readonly table: Table;
  readonly focus: Focus;
}

/** Tabela lida do documento de trabalho e a célula do cursor (`Focus` do upstream). */
function locate(
  engine: TableEngine,
  editor: StateTextEditor,
  rows: TableRows,
  options: TableOptions,
): Located | null {
  const lines: string[] = [];
  for (let row = rows.startRow; row <= rows.endRow; row++) lines.push(editor.getLine(row));
  const table = engine.readTable(lines, options);
  const focus = table.focusOfPosition(editor.getCursorPosition(), rows.startRow);
  return focus ? { ...rows, table, focus } : null;
}

/** Tabela completada (células faltantes vazias) para as operações próprias. */
function completed(engine: TableEngine, info: Located, options: TableOptions): Located {
  const done = engine.completeTable(info.table, options);
  const focus =
    done.delimiterInserted && info.focus.row > 0 ? info.focus.setRow(info.focus.row + 1) : info.focus;
  return { ...info, table: done.table, focus };
}

/** Formata `altered`, troca as linhas da tabela e põe o cursor no início da célula `focus`. */
function rebuild(
  engine: TableEngine,
  editor: StateTextEditor,
  info: Located,
  options: TableOptions,
  altered: Table,
  focus: Focus,
): void {
  const formatted = engine.formatTable(altered, options).table;
  editor.replaceLines(info.startRow, info.endRow + 1, formatted.toLines());
  const cell = formatted.getFocusedCell(focus);
  const point = formatted.positionOfFocus(
    focus.setOffset(cell ? cell.computeRawOffset(0) : 0),
    info.startRow,
  );
  if (point) editor.setCursorPosition(point);
}

/** Número com UM separador decimal, `.` ou `,` (pt-BR), sem milhar (D-R7-S3-03b). */
const NUMBER = /^\s*[-+]?(?:\d+(?:[.,]\d+)?|\d+[.,]|[.,]\d+)(?:[eE][-+]?\d+)?\s*$/;
const collator = new Intl.Collator('pt-BR', { numeric: true });

/**
 * "Ordenar linhas por esta coluna" (texto pt-BR ou número): numérico só se toda célula não vazia da
 * coluna é número; senão `Intl.Collator('pt-BR')` sem as marcas `*~_$` (como o upstream). Vazias
 * primeiro no crescente; decrescente = inverso; ordenação estável.
 */
function sortRows(
  engine: TableEngine,
  editor: StateTextEditor,
  info: Located,
  options: TableOptions,
  descending: boolean,
): void {
  const { table, focus } = info;
  const column = Math.min(Math.max(focus.column, 0), table.getHeaderWidth() - 1);
  const rows = table.getRows();
  const valueOf = (row: TableRow) => row.getCellAt(column)?.content ?? '';
  const body = rows.slice(2);
  const numeric = body.every((row) => valueOf(row) === '' || NUMBER.test(valueOf(row)));
  const key = (text: string) =>
    numeric ? Number.parseFloat(text.replace(',', '.')) : text.replace(/[*~_$]/g, '');
  body.sort((a, b) => {
    const x = valueOf(a);
    const y = valueOf(b);
    if (x === '' || y === '') return x === y ? 0 : x === '' ? -1 : 1;
    const kx = key(x);
    const ky = key(y);
    return typeof kx === 'number' && typeof ky === 'number'
      ? kx - ky
      : collator.compare(String(kx), String(ky));
  });
  if (descending) body.reverse();
  rebuild(engine, editor, info, options, new engine.Table([...rows.slice(0, 2), ...body]), focus);
}

/** Linha vazia com a largura do cabeçalho. */
function emptyRow(engine: TableEngine, width: number): TableRow {
  return new engine.TableRow(
    Array.from({ length: width }, () => new engine.TableCell('')),
    '',
    '',
  );
}

/** Texto do anúncio STR-156 para a célula do cursor. */
function describe(info: Located | null): string | null {
  if (!info) return null;
  const width = info.table.getHeaderWidth();
  const column = Math.min(Math.max(info.focus.column, 0), Math.max(width - 1, 0)) + 1;
  return info.focus.row <= 1
    ? TABLE_TEXT.header(column)
    : TABLE_TEXT.row(info.focus.row - 1, column);
}

/** Aplica um comando agora (motor carregado); devolve o anúncio, se houver. */
function apply(
  engine: TableEngine,
  editor: StateTextEditor,
  id: TableCommandId,
  rows: TableRows,
): string | null {
  const { normal, sameColumn } = tableOptions(engine);
  normalizePipes(editor, rows);
  const before = locate(engine, editor, rows, normal);
  if (!before) return null;
  const te = new engine.TableEditor(editor);
  const lastRow = editor.getLastRow();
  switch (id) {
    case 'format':
      te.format(normal);
      break;
    case 'next-cell': {
      // D-R7-S3-05b: na última célula da linha vai para a 1ª da próxima (cria no fim da tabela).
      const last = before.focus.column >= before.table.getHeaderWidth() - 1;
      if (before.focus.row !== 1 && last) te.nextRow(normal);
      else te.nextCell(normal);
      break;
    }
    case 'prev-cell':
      te.previousCell(normal);
      break;
    case 'next-row':
      te.nextRow(sameColumn);
      break;
    case 'insert-row-above':
      te.insertRow(normal);
      break;
    case 'insert-row-below': {
      const info = completed(engine, before, normal);
      const at = Math.max(info.focus.row + 1, 2);
      const width = info.table.getHeaderWidth();
      const altered = engine.insertRow(info.table, at, emptyRow(engine, width));
      rebuild(engine, editor, info, normal, altered, new engine.Focus(at, 0, 0));
      break;
    }
    case 'delete-row':
      te.deleteRow(normal);
      break;
    case 'insert-col-left':
      te.insertColumn(normal);
      break;
    case 'insert-col-right': {
      const info = completed(engine, before, normal);
      const width = info.table.getHeaderWidth();
      const at = Math.min(Math.max(info.focus.column + 1, 0), width);
      const cells = Array.from(
        { length: info.table.getHeight() - 1 },
        () => new engine.TableCell(''),
      );
      const altered = engine.insertColumn(info.table, at, cells, normal);
      const row = info.focus.row === 1 ? 0 : info.focus.row;
      rebuild(engine, editor, info, normal, altered, new engine.Focus(row, at, 0));
      break;
    }
    case 'delete-col':
      te.deleteColumn(normal);
      break;
    case 'move-row-up':
    case 'move-row-down':
      te.moveRow(id === 'move-row-up' ? -1 : 1, normal);
      break;
    case 'move-col-left':
    case 'move-col-right':
      te.moveColumn(id === 'move-col-left' ? -1 : 1, normal);
      break;
    case 'align-left':
      te.alignColumn(engine.Alignment.LEFT, normal);
      break;
    case 'align-center':
      te.alignColumn(engine.Alignment.CENTER, normal);
      break;
    case 'align-right':
      te.alignColumn(engine.Alignment.RIGHT, normal);
      break;
    case 'align-none':
      te.alignColumn(engine.Alignment.NONE, normal);
      break;
    case 'sort-asc':
    case 'sort-desc':
      sortRows(engine, editor, completed(engine, before, normal), normal, id === 'sort-desc');
      break;
    case 'transpose':
      te.transpose(normal);
      break;
    case 'format-all':
      // Tratado em `execute` (todas as tabelas de topo).
      break;
  }
  if (!ANNOUNCED[id]) return null;
  const added = editor.getLastRow() - lastRow;
  if (added > 0) return TABLE_TEXT.created;
  return describe(locate(engine, editor, { ...rows, endRow: rows.endRow + added }, normal));
}

/**
 * "Formatar todas as tabelas": de baixo para cima, então as linhas de cima não andam. A tabela do
 * cursor é formatada com o cursor nela (o upstream mantém a célula); as de cima só deslocam a
 * seleção pelo que mudou de tamanho antes dela.
 */
function formatAll(
  engine: TableEngine,
  editor: StateTextEditor,
  state: EditorState,
  tables: readonly TableRows[],
  current: TableRows,
): void {
  const { normal } = tableOptions(engine);
  const te = new engine.TableEditor(editor);
  let kept: EditorSnapshot | null = null;
  for (const rows of [...tables].reverse()) {
    normalizePipes(editor, rows);
    if (rows.startRow === current.startRow) {
      // Só as tabelas de baixo mudaram até aqui: as posições originais da seleção valem.
      editor.select(state.selection.main.anchor, state.selection.main.head);
      te.format(normal);
      kept = editor.snapshot();
    } else {
      editor.setCursorPosition(new engine.Point(rows.startRow, 0));
      te.format(normal);
    }
  }
  if (kept) {
    const shift = editor.snapshot().length - kept.length;
    editor.select(kept.anchor + shift, kept.head + shift);
  }
}

/**
 * Executa um comando com o cursor em `head` numa tabela de topo: UMA transação (um passo de
 * desfazer, isolado no histórico), seleção = célula ativa (DA-R7-21) e anúncio STR-156.
 */
function execute(view: EditorView, engine: TableEngine, id: TableCommandId, head: number): void {
  const { state } = view;
  const context = tableAt(state, head);
  if (context?.kind !== 'top') {
    notify(view, context ? TABLE_TEXT.nested : TABLE_TEXT.outside);
    return;
  }
  let editor: StateTextEditor;
  let announcement: string | null = null;
  if (id === 'format-all') {
    const tables = topLevelTables(state);
    editor = new StateTextEditor(engine, state, head, (row) =>
      tables.some((t) => row >= t.startRow && row <= t.endRow),
    );
    formatAll(engine, editor, state, tables, context);
  } else {
    editor = new StateTextEditor(
      engine,
      state,
      head,
      (row) => row >= context.startRow && row <= context.endRow,
    );
    announcement = apply(engine, editor, id, context);
  }
  const edit = editor.finish();
  const effects: StateEffect<unknown>[] = announcement
    ? [EditorView.announce.of(announcement)]
    : [];
  view.dispatch({
    changes: edit.changes,
    selection: edit.selection,
    effects,
    scrollIntoView: true,
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.table')],
  });
}

/**
 * Comandos pedidos antes do pedaço `tables-engine` chegar (D-R7-F27): a tecla/comando é consumido
 * agora e aplicado uma vez quando o `import()` resolve, em ordem, com a posição mapeada pelas
 * edições feitas no meio tempo.
 */
class PendingCommands {
  items: { id: TableCommandId; pos: number }[] = [];
  destroyed = false;

  update(update: ViewUpdate): void {
    if (update.docChanged)
      for (const item of this.items) item.pos = update.changes.mapPos(item.pos, 1);
  }

  destroy(): void {
    this.destroyed = true;
    this.items = [];
  }
}

export const pendingTableCommands = ViewPlugin.fromClass(PendingCommands);

/**
 * Executa `table:<id>` no editor (paleta, teclas, cadeia). Fora de tabela ou em tabela aninhada →
 * aviso STR-155 e 0 mudanças (`false`). Numa tabela de topo → aplica (ou enfileira até o motor
 * carregar) e devolve `true`.
 */
export function runTableCommand(view: EditorView, id: TableCommandId): boolean {
  const head = view.state.selection.main.head;
  const context = tableAt(view.state, head);
  if (context?.kind !== 'top') {
    notify(view, context ? TABLE_TEXT.nested : TABLE_TEXT.outside);
    return false;
  }
  const engine = tableEngine();
  if (engine) {
    execute(view, engine, id, head);
    return true;
  }
  const queue = view.plugin(pendingTableCommands);
  if (!queue) {
    loadTableEngine().then(
      (loaded) => execute(view, loaded, id, view.state.selection.main.head),
      () => {},
    );
    return true;
  }
  queue.items.push({ id, pos: head });
  if (queue.items.length === 1)
    loadTableEngine().then(
      (loaded) => {
        while (!queue.destroyed && queue.items.length > 0) {
          const item = queue.items.shift();
          if (item) execute(view, loaded, item.id, item.pos);
        }
      },
      () => {
        queue.items = [];
      },
    );
  return true;
}
