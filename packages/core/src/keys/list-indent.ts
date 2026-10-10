import { ensureSyntaxTree, indentUnit, syntaxTree } from '@codemirror/language';
import { countColumn, type ChangeSpec, type EditorState, type Extension } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { contextAction } from './context-chain';

/**
 * Tempo máximo para completar a árvore antes de decidir (documentos grandes). A árvore é pedida até
 * o FIM do documento: parar na seleção cortaria o item no cursor e deixaria os subitens de fora.
 * Sem tempo, fica a árvore atual do estado (o parse continua de onde parou na próxima tecla).
 */
const PARSE_BUDGET_MS = 50;

function lineStartsItem(state: EditorState, tree: Tree, lineFrom: number): SyntaxNode | null {
  const line = state.doc.lineAt(lineFrom);
  const indent = /^[ \t]*/.exec(line.text)?.[0].length ?? 0;
  let node: SyntaxNode | null = tree.resolveInner(line.from + indent, 1);
  for (; node; node = node.parent) {
    if (node.name === 'ListItem') return node.from === line.from + indent ? node : null;
  }
  return null;
}

function innermostItem(tree: Tree, pos: number): SyntaxNode | null {
  for (let node: SyntaxNode | null = tree.resolveInner(pos, -1); node; node = node.parent)
    if (node.name === 'ListItem') return node;
  return null;
}

/**
 * Itens tocados pela seleção (cada um com seus filhos), sem os que já estão dentro de outro.
 * `tree` = a árvore completada por `ensureSyntaxTree` (o `syntaxTree(state)` fica com a árvore da
 * criação do estado e pode não chegar ao cursor num documento grande).
 */
function selectedItems(state: EditorState, tree: Tree): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    let any = false;
    for (let n = first; n <= last; n++) {
      const item = lineStartsItem(state, tree, state.doc.line(n).from);
      if (item) {
        found.push(item);
        any = true;
      }
    }
    if (!any) {
      const item = innermostItem(tree, range.head);
      if (item) found.push(item);
    }
  }
  return found.filter(
    (item, index) =>
      !found.some(
        (other, j) =>
          j !== index &&
          other.from <= item.from &&
          other.to >= item.to &&
          (other.from !== item.from || j < index),
      ),
  );
}

function columnAt(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  return countColumn(line.text.slice(0, pos - line.from), state.tabSize);
}

/** Coluna do conteúdo do item (depois do marcador e do espaço que o segue). */
function contentColumn(state: EditorState, item: SyntaxNode): number {
  const mark = item.getChild('ListMark');
  if (!mark) return columnAt(state, item.from);
  const line = state.doc.lineAt(mark.to);
  const after = /^[ \t]*/.exec(line.text.slice(mark.to - line.from))?.[0].length ?? 0;
  return columnAt(state, mark.to) + Math.max(1, after);
}

/** Desloca as linhas `[fromLine, toLine]` em `delta` colunas (negativo = remove indentação). */
function shiftLines(
  state: EditorState,
  fromLine: number,
  toLine: number,
  delta: number,
  done: Set<number>,
): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  for (let n = fromLine; n <= toLine; n++) {
    if (done.has(n)) continue;
    done.add(n);
    const line = state.doc.line(n);
    if (line.text.trim() === '') continue;
    if (delta > 0) {
      changes.push({ from: line.from, insert: ' '.repeat(delta) });
      continue;
    }
    let cut = 0;
    while (
      cut < line.text.length &&
      /[ \t]/.test(line.text[cut] ?? '') &&
      countColumn(line.text.slice(0, cut + 1), state.tabSize) <= -delta
    )
      cut++;
    if (cut > 0) changes.push({ from: line.from, to: line.from + cut });
  }
  return changes;
}

/**
 * Fallback do núcleo para o slot `list` (prioridade 0; o outliner, quando ligado, vem antes com
 * 10): indenta/desindenta o item sob o cursor JUNTO com os subitens (MELHORIAS l.23). Indentar
 * aninha o item sob o irmão anterior (coluna do conteúdo dele); o primeiro item da lista não tem
 * onde aninhar e fica como está. Desindentar leva o item ao nível do pai (ou tira uma unidade de
 * indentação no nível de topo). Dentro de uma lista a tecla é sempre consumida: Tab nunca insere
 * tabulação no meio de um item.
 */
export const listIndentAction: Extension = contextAction('list', {
  priority: 0,
  kinds: ['tab', 'indent'],
  run(view, dir) {
    const { state } = view;
    const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state);
    const items = selectedItems(state, tree);
    if (items.length === 0) return false;
    const unit = countColumn(state.facet(indentUnit), state.tabSize);
    const done = new Set<number>();
    const changes: ChangeSpec[] = [];
    for (const item of items) {
      const first = state.doc.lineAt(item.from).number;
      const last = state.doc.lineAt(Math.max(item.from, item.to - 1)).number;
      const column = columnAt(state, item.from);
      let delta = 0;
      if (dir === 1) {
        const prev = item.prevSibling;
        if (prev?.name === 'ListItem') delta = Math.max(1, contentColumn(state, prev) - column);
      } else {
        const list = item.parent;
        const parent = list?.parent?.name === 'ListItem' ? list.parent : null;
        delta = -(parent ? column - columnAt(state, parent.from) : Math.min(column, unit));
      }
      if (delta !== 0) changes.push(...shiftLines(state, first, last, delta, done));
    }
    if (changes.length > 0)
      view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.indent' });
    return true;
  },
});
