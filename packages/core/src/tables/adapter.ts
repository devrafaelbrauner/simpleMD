import {
  ChangeSet,
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Text,
} from '@codemirror/state';
import type { ITextEditor, Point, Range } from '@tgrosinger/md-advanced-tables';
import { CLUSTER_SLOTS, type TableEngine } from './engine';

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

/** Sinais de um emoji de vários pontos de código (ZWJ, VS16, keycap, tom de pele, bandeira, tag). */
const CLUSTER_HINT =
  /\u200D|\uFE0F|\u20E3|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u{E0020}-\u{E007F}]/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;
const SLOT_PATTERN = new RegExp(`[${CLUSTER_SLOTS.join('')}]`, 'gu');
let graphemes: Intl.Segmenter | null = null;

/**
 * `ITextEditor` do upstream sobre um `EditorState` do CodeMirror (arch-frontend r7 §7). As linhas
 * (`row`, a partir de 0) e colunas (`column`, unidades UTF-16 como as posições do CM) são lidas de
 * um documento de trabalho; cada edição vira um `ChangeSet` mínimo (prefixo/sufixo comuns) composto
 * no total, e a seleção é mapeada por ele. Nada é despachado aqui: `finish()` devolve UMA transação
 * para o comando inteiro, inclusive o que o upstream faz fora de `transact` (ex.: `transpose`).
 *
 * Largura de emoji: o `meaw` soma a largura de cada ponto de código, então 👍🏽, 👨‍👩‍👧 ou 1️⃣
 * dariam 3–6 colunas. O upstream vê cada um desses aglomerados como UM caractere reservado (um
 * não-caractere Unicode de `CLUSTER_SLOTS`, largo = 2) e o texto escrito volta ao original. Um
 * não-caractere que já esteja no texto nunca é usado como reservado (CR-S3-01); sem reservado
 * livre, o aglomerado fica como está (largura do `meaw`).
 */
export class StateTextEditor implements ITextEditor {
  /** Documento no início da sessão: o único texto que não veio do upstream. */
  readonly #initial: Text;
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
    this.#initial = this.#doc = state.doc;
    this.#changes = ChangeSet.empty(state.doc.length);
    const main = state.selection.main;
    this.#anchor = main.head === head ? main.anchor : head;
    this.#head = head;
  }

  /** Aglomerado de emoji ↔ caractere reservado, nesta sessão. */
  readonly #toSlot = new Map<string, string>();
  readonly #fromSlot = new Map<string, string>();
  /** Reservados que já aparecem no documento (lido só na 1ª alocação). */
  #taken: Set<string> | null = null;
  #nextSlot = 0;

  /**
   * Reservado de um aglomerado de vários pontos de código com emoji; `undefined` para o resto ou
   * quando os reservados livres acabaram. Todo texto que o upstream escreve vem de `getLine`
   * (codificado), então só o documento inicial pode ter um reservado literal.
   */
  #slotFor(segment: string): string | undefined {
    if (segment.length < 2 || [...segment].length < 2 || !EMOJI.test(segment)) return undefined;
    const known = this.#toSlot.get(segment);
    if (known !== undefined) return known;
    if (!this.#taken) {
      const taken = new Set<string>();
      for (const iter = this.#initial.iter(); !iter.next().done;)
        for (const [slot] of iter.value.matchAll(SLOT_PATTERN)) taken.add(slot);
      this.#taken = taken;
    }
    while (this.#nextSlot < CLUSTER_SLOTS.length) {
      const slot = CLUSTER_SLOTS[this.#nextSlot++];
      if (slot === undefined || this.#taken.has(slot)) continue;
      this.#toSlot.set(segment, slot);
      this.#fromSlot.set(slot, segment);
      return slot;
    }
    return undefined;
  }

  /** Texto como o upstream o vê: cada emoji de vários pontos de código vira um caractere largo. */
  #encode(text: string): string {
    if (!CLUSTER_HINT.test(text)) return text;
    graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let out = '';
    for (const { segment } of graphemes.segment(text)) out += this.#slotFor(segment) ?? segment;
    return out;
  }

  /**
   * Coluna codificada de `raw` (UTF-16 em `text`): conta a linha inteira por aglomerado, e um
   * offset no meio de um aglomerado trocado vai para o início dele (CR-S3-04).
   */
  #encodedColumn(text: string, raw: number): number {
    if (!CLUSTER_HINT.test(text)) return raw;
    graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let column = 0;
    for (const { segment, index } of graphemes.segment(text)) {
      if (index >= raw) break;
      const slot = this.#slotFor(segment);
      if (slot === undefined) column += Math.min(segment.length, raw - index);
      else if (index + segment.length <= raw) column += slot.length;
    }
    return column;
  }

  #decode(text: string): string {
    if (this.#fromSlot.size === 0) return text;
    return text.replace(SLOT_PATTERN, (slot) => this.#fromSlot.get(slot) ?? slot);
  }

  /** Posição do documento de trabalho para um ponto do upstream (limitada à linha). */
  offsetOf(point: Point): number {
    const line = this.#doc.line(Math.min(Math.max(point.row, 0), this.#doc.lines - 1) + 1);
    const column = Math.max(point.column, 0);
    const real = this.#decode(this.#encode(line.text).slice(0, column)).length;
    return line.from + Math.min(real, line.length);
  }

  getCursorPosition(): Point {
    const line = this.#doc.lineAt(this.#head);
    const column = this.#encodedColumn(line.text, this.#head - line.from);
    return new this.engine.Point(line.number - 1, column);
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
    return this.#encode(this.#doc.line(row + 1).text);
  }

  insertLine(row: number, text: string): void {
    const line = this.#decode(text);
    if (row >= this.#doc.lines) this.#apply({ from: this.#doc.length, insert: `\n${line}` });
    else this.#apply({ from: this.#doc.line(row + 1).from, insert: `${line}\n` });
  }

  deleteLine(row: number): void {
    const line = this.#doc.line(row + 1);
    if (row + 1 < this.#doc.lines)
      this.#apply({ from: line.from, to: this.#doc.line(row + 2).from });
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
    const after = this.#decode(lines.join('\n'));
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
