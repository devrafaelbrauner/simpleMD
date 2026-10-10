// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/operations/DeleteTillPreviousLineContentEnd.ts (Backspace no início do conteúdo: une
// com a nota/item anterior). Mudanças: tipos estritos.

import type { Operation } from '../model/perform';
import {
  recalculateNumericBullets,
  type List,
  type ListLine,
  type Position,
  type Root,
} from '../model/root';

export class DeleteTillPreviousLineContentEnd implements Operation {
  private stopPropagation = false;
  private updated = false;

  constructor(private root: Root) {}

  shouldStopPropagation(): boolean {
    return this.stopPropagation;
  }

  shouldUpdate(): boolean {
    return this.updated;
  }

  perform(): void {
    const { root } = this;

    if (!root.hasSingleCursor()) return;

    const list = root.getListUnderCursor();
    const cursor = root.getCursor();
    const lines = list.getLinesInfo();

    const lineNo = lines.findIndex((l) => cursor.ch === l.from.ch && cursor.line === l.from.line);

    if (lineNo === 0) this.mergeWithPreviousItem(root, cursor, list);
    else if (lineNo > 0) this.mergeNotes(root, cursor, list, lines, lineNo);
  }

  private mergeNotes(
    root: Root,
    cursor: Position,
    list: List,
    lines: ListLine[],
    lineNo: number,
  ): void {
    this.stopPropagation = true;
    this.updated = true;

    const prev = lines[lineNo - 1]!;

    root.replaceCursor({ line: cursor.line - 1, ch: prev.text.length + prev.from.ch });

    prev.text += lines[lineNo]!.text;
    lines.splice(lineNo, 1);

    list.replaceLines(lines.map((l) => l.text));
  }

  private mergeWithPreviousItem(root: Root, cursor: Position, list: List): void {
    if (root.getChildren()[0] === list && list.isEmpty()) return;

    this.stopPropagation = true;

    const prev = root.getListUnderLine(cursor.line - 1);

    if (!prev) return;

    const bothAreEmpty = prev.isEmpty() && list.isEmpty();
    const prevIsEmptyAndSameLevel =
      prev.isEmpty() && !list.isEmpty() && prev.getLevel() === list.getLevel();
    const listIsEmptyAndPrevIsParent = list.isEmpty() && prev.getLevel() === list.getLevel() - 1;

    if (bothAreEmpty || prevIsEmptyAndSameLevel || listIsEmptyAndPrevIsParent) {
      this.updated = true;

      const parent = list.getParent()!;
      const prevEnd = prev.getLastLineContentEnd();
      const listNotesIndent = list.getNotesIndent();

      if (!prev.getNotesIndent() && listNotesIndent)
        prev.setNotesIndent(
          prev.getFirstLineIndent() + listNotesIndent.slice(list.getFirstLineIndent().length),
        );

      const oldLines = prev.getLines();
      const newLines = list.getLines();
      oldLines[oldLines.length - 1] += newLines[0]!;
      const resultLines = oldLines.concat(newLines.slice(1));

      prev.replaceLines(resultLines);
      parent.removeChild(list);

      for (const c of list.getChildren()) {
        list.removeChild(c);
        prev.addAfterAll(c);
      }

      root.replaceCursor(prevEnd);

      recalculateNumericBullets(root);
    }
  }
}
