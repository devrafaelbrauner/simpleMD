// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/operations/MoveCursorToPreviousUnfoldedLine.ts (← no início do conteúdo vai ao fim
// da linha visível anterior, pulando o marcador e as dobras). Mudanças: tipos estritos.

import type { Operation } from '../model/perform';
import type { ListLine, Position, Root } from '../model/root';

export class MoveCursorToPreviousUnfoldedLine implements Operation {
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
    const lineNo = lines.findIndex(
      (l) => cursor.ch === l.from.ch + list.getCheckboxLength() && cursor.line === l.from.line,
    );

    if (lineNo === 0) this.moveCursorToPreviousUnfoldedItem(root, cursor);
    else if (lineNo > 0) this.moveCursorToPreviousNoteLine(root, lines, lineNo);
  }

  private moveCursorToPreviousNoteLine(root: Root, lines: ListLine[], lineNo: number): void {
    this.stopPropagation = true;
    this.updated = true;
    root.replaceCursor(lines[lineNo - 1]!.to);
  }

  private moveCursorToPreviousUnfoldedItem(root: Root, cursor: Position): void {
    const prev = root.getListUnderLine(cursor.line - 1);

    if (!prev) return;

    this.stopPropagation = true;
    this.updated = true;

    if (prev.isFolded()) {
      const foldRoot = prev.getTopFoldRoot()!;
      root.replaceCursor(foldRoot.getLinesInfo()[0]!.to);
    } else {
      root.replaceCursor(prev.getLastLineContentEnd());
    }
  }
}
