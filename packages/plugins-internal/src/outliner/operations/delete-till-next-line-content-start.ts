// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/operations/DeleteTillNextLineContentStart.ts (Delete no fim do conteúdo: une com a
// próxima nota/item). Mudanças: tipos estritos.

import type { Operation } from '../model/perform';
import type { Root } from '../model/root';
import { DeleteTillPreviousLineContentEnd } from './delete-till-previous-line-content-end';

export class DeleteTillNextLineContentStart implements Operation {
  private deleteTillPreviousLineContentEnd: DeleteTillPreviousLineContentEnd;

  constructor(private root: Root) {
    this.deleteTillPreviousLineContentEnd = new DeleteTillPreviousLineContentEnd(root);
  }

  shouldStopPropagation(): boolean {
    return this.deleteTillPreviousLineContentEnd.shouldStopPropagation();
  }

  shouldUpdate(): boolean {
    return this.deleteTillPreviousLineContentEnd.shouldUpdate();
  }

  perform(): void {
    const { root } = this;

    if (!root.hasSingleCursor()) return;

    const list = root.getListUnderCursor();
    const cursor = root.getCursor();
    const lines = list.getLinesInfo();

    const lineNo = lines.findIndex((l) => cursor.ch === l.to.ch && cursor.line === l.to.line);

    if (lineNo === lines.length - 1) {
      const nextLine = lines[lineNo]!.to.line + 1;
      const nextList = root.getListUnderLine(nextLine);
      if (!nextList) return;
      root.replaceCursor(nextList.getFirstLineContentStart());
      this.deleteTillPreviousLineContentEnd.perform();
    } else if (lineNo >= 0) {
      root.replaceCursor(lines[lineNo + 1]!.from);
      this.deleteTillPreviousLineContentEnd.perform();
    }
  }
}
