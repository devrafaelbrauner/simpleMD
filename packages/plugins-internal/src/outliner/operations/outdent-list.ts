// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/operations/OutdentList.ts (desindenta o item com a subárvore para depois do pai).
// Mudanças: tipos estritos.

import type { Operation } from '../model/perform';
import { recalculateNumericBullets, type Root } from '../model/root';

export class OutdentList implements Operation {
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

    this.stopPropagation = true;

    const list = root.getListUnderCursor();
    const parent = list.getParent()!;
    const grandParent = parent.getParent();

    if (!grandParent) return;

    this.updated = true;

    const listStartLineBefore = root.getContentLinesRangeOf(list)![0];
    const indentRmFrom = parent.getFirstLineIndent().length;
    const indentRmTill = list.getFirstLineIndent().length;

    parent.removeChild(list);
    grandParent.addAfter(parent, list);
    list.unindentContent(indentRmFrom, indentRmTill);

    const listStartLineAfter = root.getContentLinesRangeOf(list)![0];
    const lineDiff = listStartLineAfter - listStartLineBefore;
    const chDiff = indentRmTill - indentRmFrom;

    const cursor = root.getCursor();
    root.replaceCursor({ line: cursor.line + lineDiff, ch: cursor.ch - chDiff });

    recalculateNumericBullets(root);
  }
}
