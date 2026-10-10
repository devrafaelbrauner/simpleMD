// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/editor/index.ts (`MyEditor`). Reescrito sobre o `EditorView` do CodeMirror, sem o
// `Editor` do pacote `obsidian` nem o Zoom: linhas e colunas contadas a partir de 0, como no
// upstream; `transact` junta as chamadas de uma operação numa ÚNICA transação (um passo de desfazer).

import { foldable, foldedRanges, foldEffect, unfoldEffect } from '@codemirror/language';
import {
  ChangeSet,
  EditorSelection,
  StateEffect,
  type EditorState,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export interface MyEditorPosition {
  line: number;
  ch: number;
}

export interface MyEditorSelection {
  anchor: MyEditorPosition;
  head: MyEditorPosition;
}

/** Primeira faixa dobrada que começa dentro de [from, to] (a dobra de um item começa no fim da linha). */
function foldInside(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(state).between(from, to, (rangeFrom, rangeTo) => {
    if (!found || found.from > rangeFrom) found = { from: rangeFrom, to: rangeTo };
  });
  return found;
}

export class MyEditor {
  private batch: { state: EditorState; trs: Transaction[] } | null = null;

  constructor(readonly view: EditorView) {}

  /** Estado visto pelas leituras: o da transação em montagem, ou o do editor. */
  get state(): EditorState {
    return this.batch?.state ?? this.view.state;
  }

  private run(spec: TransactionSpec): void {
    if (!this.batch) {
      this.view.dispatch(spec);
      return;
    }
    const tr = this.batch.state.update(spec);
    this.batch.trs.push(tr);
    this.batch.state = tr.state;
  }

  /**
   * Junta as mudanças, efeitos (dobras) e a seleção feitas em `fn` numa transação só, marcada com
   * `userEvent` (ex.: `move.line`, que o histórico não emenda com a anterior).
   */
  transact(userEvent: string, fn: () => void): void {
    const batch = { state: this.view.state, trs: [] as Transaction[] };
    this.batch = batch;
    try {
      fn();
    } finally {
      this.batch = null;
    }
    if (batch.trs.length === 0) return;
    let changes = ChangeSet.empty(this.view.state.doc.length);
    let effects: StateEffect<unknown>[] = [];
    for (const tr of batch.trs) {
      effects = StateEffect.mapEffects(effects, tr.changes).concat(tr.effects);
      changes = changes.compose(tr.changes);
    }
    // Numa transação só, o `foldState` exige as dobras novas em ordem de posição (o upstream fazia
    // uma transação por dobra): desdobras primeiro, como antes, depois as dobras ordenadas.
    const folds = effects
      .flatMap((effect) => (effect.is(foldEffect) ? [effect] : []))
      .sort((a, b) => a.value.from - b.value.from);
    this.view.dispatch({
      changes,
      effects: effects.filter((effect) => !effect.is(foldEffect)).concat(folds),
      ...(batch.trs.some((tr) => tr.selection) ? { selection: batch.state.selection } : {}),
      userEvent,
      scrollIntoView: true,
    });
  }

  getCursor(): MyEditorPosition {
    return this.offsetToPos(this.state.selection.main.head);
  }

  getLine(n: number): string {
    return this.state.doc.line(n + 1).text;
  }

  lastLine(): number {
    return this.state.doc.lines - 1;
  }

  listSelections(): MyEditorSelection[] {
    return this.state.selection.ranges.map((range) => ({
      anchor: this.offsetToPos(range.anchor),
      head: this.offsetToPos(range.head),
    }));
  }

  getRange(from: MyEditorPosition, to: MyEditorPosition): string {
    return this.state.sliceDoc(this.posToOffset(from), this.posToOffset(to));
  }

  replaceRange(replacement: string, from: MyEditorPosition, to: MyEditorPosition): void {
    this.run({
      changes: { from: this.posToOffset(from), to: this.posToOffset(to), insert: replacement },
    });
  }

  setSelections(selections: MyEditorSelection[]): void {
    this.run({
      selection: EditorSelection.create(
        selections.map((s) =>
          EditorSelection.range(this.posToOffset(s.anchor), this.posToOffset(s.head)),
        ),
        selections.length - 1,
      ),
    });
  }

  setValue(text: string): void {
    this.run({ changes: { from: 0, to: this.state.doc.length, insert: text } });
  }

  getValue(): string {
    return this.state.doc.toString();
  }

  offsetToPos(offset: number): MyEditorPosition {
    const line = this.state.doc.lineAt(offset);
    return { line: line.number - 1, ch: offset - line.from };
  }

  /** Linha e coluna fora do documento são presas às bordas (como o `posToOffset` do Obsidian). */
  posToOffset(pos: MyEditorPosition): number {
    const { doc } = this.state;
    const line = doc.line(Math.min(Math.max(pos.line, 0), doc.lines - 1) + 1);
    return line.from + Math.min(Math.max(pos.ch, 0), line.length);
  }

  fold(n: number): void {
    const { state } = this;
    const line = state.doc.line(n + 1);
    const range = foldable(state, line.from, line.to);
    if (!range || range.from === range.to) return;
    let already = false;
    foldedRanges(state).between(range.from, range.to, (from, to) => {
      if (from === range.from && to === range.to) already = true;
    });
    if (!already) this.run({ effects: foldEffect.of(range) });
  }

  unfold(n: number): void {
    const { state } = this;
    const line = state.doc.line(n + 1);
    const range = foldInside(state, line.from, line.to);
    if (range) this.run({ effects: unfoldEffect.of(range) });
  }

  getAllFoldedLines(): number[] {
    const res: number[] = [];
    for (let c = foldedRanges(this.state).iter(); c.value; c.next())
      res.push(this.offsetToPos(c.from).line);
    return res;
  }
}
