// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/operations/KeepCursorOutsideFoldedLines.ts (cursor dentro de um item dobrado volta
// para o fim da linha do item dobrado). Mudanças: tipos estritos.

import type { Operation } from '../model/perform';
import type { Root } from '../model/root';

export class KeepCursorOutsideFoldedLines implements Operation {
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

    const cursor = root.getCursor();

    const list = root.getListUnderCursor();
    if (!list.isFolded()) return;

    const foldRoot = list.getTopFoldRoot()!;
    const firstLineEnd = foldRoot.getLinesInfo()[0]!.to;

    if (cursor.line > firstLineEnd.line) {
      this.updated = true;
      this.stopPropagation = true;
      root.replaceCursor(firstLineEnd);
    }
  }
}
