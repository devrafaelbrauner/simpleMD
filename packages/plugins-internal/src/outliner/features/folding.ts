// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/features/ListsFoldingCommands.ts (dobrar/desdobrar o item sob o cursor). Mudanças: a
// dobra por indentação do Obsidian ("Fold indent") virou um `foldService` próprio para itens de
// lista + `codeFolding()` sem calha (D-R7-F24); marcador reestilizado com a contagem (STR-175);
// "Dobrar tudo"/"Desdobrar tudo" novos (R-I7.1); anúncios (arch-ux §7.2). Dobra é só visual.

import {
  codeFolding,
  foldable,
  foldedRanges,
  foldEffect,
  foldService,
  unfoldEffect,
} from '@codemirror/language';
import { countColumn, EditorState, type Extension, type StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { OutlinerContext } from '../context';
import { MyEditor } from '../model/editor';
import { OUTLINER_TEXT } from '../text';

const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d+\.)[ \t]/;
const ITEM_TEXT = /^[ \t]*(?:[-*+]|\d+\.)[ \t]+(?:\[[^[\]]\][ \t])?/;
const BLANK = /^\s*$/;
const MAX_TITLE = 80;

/**
 * Dobra de um item de lista: do fim da linha do item até a última linha mais indentada que ele
 * (subitens e notas; linhas vazias no meio contam, as do fim não). `null` fora de item ou sem filhos.
 */
export function listItemFoldRange(
  state: EditorState,
  lineStart: number,
): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineStart);
  const match = LIST_ITEM.exec(line.text);
  if (!match) return null;
  const indent = countColumn(match[1] ?? '', state.tabSize);
  let end = line.to;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const next = state.doc.line(n);
    if (BLANK.test(next.text)) continue;
    const leading = /^[ \t]*/.exec(next.text)?.[0] ?? '';
    if (countColumn(leading, state.tabSize) <= indent) break;
    end = next.to;
  }
  return end > line.to ? { from: line.to, to: end } : null;
}

/** Texto do item da linha (sem marcador nem caixa), para o `title` de guias e marcadores. */
export function itemLabel(text: string): string {
  const label = text.replace(ITEM_TEXT, '').trim();
  return label.length > MAX_TITLE ? `${label.slice(0, MAX_TITLE - 1)}…` : label;
}

interface Prepared {
  readonly count: number;
  readonly item: string;
}

function preparePlaceholder(state: EditorState, range: { from: number; to: number }): Prepared {
  let count = 0;
  const first = state.doc.lineAt(range.from);
  for (let n = first.number + 1; n <= state.doc.lineAt(range.to).number; n++)
    if (LIST_ITEM.test(state.doc.line(n).text)) count++;
  return { count, item: itemLabel(first.text) };
}

/** Dobra (`codeFolding` sem calha) + serviço de dobra de item + marcador com nome (STR-175). */
export function foldingExtension(ctx: OutlinerContext): Extension {
  return [
    foldService.of((state, lineStart) => listItemFoldRange(state, lineStart)),
    codeFolding({
      preparePlaceholder,
      placeholderDOM(_view, onclick, prepared: Prepared) {
        const element = document.createElement('span');
        element.className = 'cm-foldPlaceholder';
        element.textContent = '…';
        element.setAttribute('aria-label', OUTLINER_TEXT.foldedCount(prepared.count));
        element.title = OUTLINER_TEXT.unfoldPlaceholder(prepared.item);
        element.onclick = (event) => {
          onclick(event);
          ctx.announce(OUTLINER_TEXT.unfolded);
        };
        return element;
      },
    }),
    EditorState.phrases.of(OUTLINER_TEXT.phrases),
  ];
}

function foldedCount(state: EditorState): number {
  return foldedRanges(state).size;
}

/** "Lista: Dobrar item" / "Lista: Desdobrar item" no item do cursor (upstream `setFold`). */
export function setFold(ctx: OutlinerContext, view: EditorView, type: 'fold' | 'unfold'): boolean {
  const editor = new MyEditor(view);
  const before = foldedCount(view.state);
  const cursor = editor.getCursor();
  if (type === 'fold') editor.fold(cursor.line);
  else editor.unfold(cursor.line);
  const after = foldedCount(view.state);
  if (type === 'fold' && after > before) ctx.announce(OUTLINER_TEXT.folded);
  if (type === 'unfold' && after < before) ctx.announce(OUTLINER_TEXT.unfolded);
  return true;
}

/** "Lista: Dobrar tudo": cada item com filhos que ainda não está dentro de uma dobra. */
export function foldAll(view: EditorView): boolean {
  const { state } = view;
  const effects: StateEffect<unknown>[] = [];
  let coveredTo = -1;
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (line.from <= coveredTo || !LIST_ITEM.test(line.text)) continue;
    const range = foldable(state, line.from, line.to);
    if (!range) continue;
    let already = false;
    foldedRanges(state).between(range.from, range.to, (from, to) => {
      if (from === range.from && to === range.to) already = true;
    });
    if (!already) effects.push(foldEffect.of(range));
    coveredTo = range.to;
  }
  if (effects.length > 0) view.dispatch({ effects });
  return true;
}

/** "Lista: Desdobrar tudo". */
export function unfoldAll(view: EditorView): boolean {
  const effects: StateEffect<unknown>[] = [];
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
    effects.push(unfoldEffect.of({ from, to }));
  });
  if (effects.length > 0) view.dispatch({ effects });
  return true;
}
