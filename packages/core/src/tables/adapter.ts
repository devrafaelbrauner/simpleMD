import { ChangeSet, EditorSelection, type ChangeSpec, type EditorState, type Text } from '@codemirror/state';
import type { ITextEditor, Point, Range } from '@tgrosinger/md-advanced-tables';
import type { TableEngine } from './engine';

/** Resultado de uma sessão do adaptador: aplicado numa ÚNICA transação (um passo de desfazer). */
export interface TableEdit {
  readonly changes: ChangeSet;
  readonly selection: EditorSelection;
}

/** Seleção e tamanho do documento de trabalho num momento da sessão. */
export interface EditorSnapshot {
  readonly anchor: number;
  readonly head: number;
  readonly length: number;
}

/** Fim do prefixo comum de `a` e `b`, sem partir um par substituto (UTF-16). */
function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i > 0 && i < max && /[\uD800-\uDBFF]/.test(a.charAt(i - 1))) i--;
  return i;
}

/**
 * `ITextEditor` do upstream sobre um `EditorState` do CodeMirror (arch-frontend r7 §7). As linhas
 * (`row`, a partir de 0) e colunas (`column`, unidades UTF-16 como as posições do CM) são lidas de
 * um documento de trabalho; cada edição vira um `ChangeSet` mínimo (prefixo/sufixo comuns) composto
 * no total, e a seleção é mapeada por ele. Nada é despachado aqui: `finish()` devolve UMA transação
 * para o comando inteiro, inclusive o que o upstream faz fora de `transact` (ex.: `transpose`).
 */
export class StateTextEditor implements ITextEditor {
  #doc: Text;
  #changes: ChangeSet;
  #anchor: number;
  #head: number;

  constructor(
    private readonly engine: TableEngine,
    state: EditorState,
    head: number,
    /** `acceptsTableEdit`: só as linhas da(s) tabela(s) de topo pedidas (R-I3.2). */
    private readonly accepts: (row: number) => boolean,
  ) {
    this.#doc = state.doc;
    this.#changes = ChangeSet.empty(state.doc.length);
    const main = state.selection.main;
    this.#anchor = main.head === head ? main.anchor : head;
    this.#head = head;
  }

  /** Posição do documento de trabalho para um ponto do upstream (limitada à linha). */
  offsetOf(point: Point): number {
    const line = this.#doc.line(Math.min(Math.max(point.row, 0), this.#doc.lines - 1) + 1);
    return line.from + Math.min(Math.max(point.column, 0), line.length);
  }

  getCursorPosition(): Point {
    const line = this.#doc.lineAt(this.#head);
    return new this.engine.Point(line.number - 1, this.#head - line.from);
  }

  setCursorPosition(pos: Point): void {
    this.#anchor = this.#head = this.offsetOf(pos);
  }

  setSelectionRange(range: Range): void {
    this.#anchor = this.offsetOf(range.start);
    this.#head = this.offsetOf(range.end);
  }

  /** Seleção atual e tamanho do documento de trabalho (para "Formatar todas as tabelas"). */
  snapshot(): EditorSnapshot {
    return { anchor: this.#anchor, head: this.#head, length: this.#doc.length };
  }

  /** Seleção em posições do documento de trabalho. */
  select(anchor: number, head: number): void {
    this.#anchor = anchor;
    this.#head = head;
  }

  getLastRow(): number {
    return this.#doc.lines - 1;
  }

  acceptsTableEdit(row: number): boolean {
    return this.accepts(row);
  }

  getLine(row: number): string {
    return this.#doc.line(row + 1).text;
  }

  insertLine(row: number, line: string): void {
    if (row >= this.#doc.lines) this.#apply({ from: this.#doc.length, insert: `\n${line}` });
    else this.#apply({ from: this.#doc.line(row + 1).from, insert: `${line}\n` });
  }

  deleteLine(row: number): void {
    const line = this.#doc.line(row + 1);
    if (row + 1 < this.#doc.lines) this.#apply({ from: line.from, to: this.#doc.line(row + 2).from });
    else if (row > 0) this.#apply({ from: this.#doc.line(row).to, to: line.to });
    else this.#apply({ from: line.from, to: line.to });
  }

  replaceLines(startRow: number, endRow: number, lines: string[]): void {
    if (endRow <= startRow) {
      lines.forEach((line, i) => this.insertLine(startRow + i, line));
      return;
    }
    if (lines.length === 0) {
      for (let row = endRow - 1; row >= startRow; row--) this.deleteLine(row);
      return;
    }
    const from = this.#doc.line(startRow + 1).from;
    const to = this.#doc.line(endRow).to;
    const before = this.#doc.sliceString(from, to);
    const after = lines.join('\n');
    if (before === after) return;
    const head = commonPrefix(before, after);
    let tail = 0;
    while (
      tail < before.length - head &&
      tail < after.length - head &&
      before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
    )
      tail++;
    if (tail > 0 && /[\uDC00-\uDFFF]/.test(before.charAt(before.length - tail))) tail--;
    this.#apply({
      from: from + head,
      to: to - tail,
      insert: after.slice(head, after.length - tail),
    });
  }

  /** Tudo já vai para uma transação só (`finish`). */
  transact(func: () => void): void {
    func();
  }

  #apply(spec: ChangeSpec): void {
    const change = ChangeSet.of(spec, this.#doc.length);
    if (change.empty) return;
    this.#doc = change.apply(this.#doc);
    this.#changes = this.#changes.compose(change);
    this.#anchor = change.mapPos(this.#anchor, 1);
    this.#head = change.mapPos(this.#head, 1);
  }

  finish(): TableEdit {
    return {
      changes: this.#changes,
      selection: EditorSelection.single(this.#anchor, this.#head),
    };
  }
}
