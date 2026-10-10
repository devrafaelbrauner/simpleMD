// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/operations/MoveListUp.ts (sobe o item com a subárvore; no primeiro filho, vai para o
// fim do pai anterior). Mudanças: tipos estritos.

import type { Operation } from '../model/perform';
import { recalculateNumericBullets, type Root } from '../model/root';

export class MoveListUp implements Operation {
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
    const prev = parent.getPrevSiblingOf(list);

    const listStartLineBefore = root.getContentLinesRangeOf(list)![0];

    if (!prev && grandParent) {
      const newParent = grandParent.getPrevSiblingOf(parent);
      if (newParent) {
        this.updated = true;
        parent.removeChild(list);
        newParent.addAfterAll(list);
      }
    } else if (prev) {
      this.updated = true;
      parent.removeChild(list);
      parent.addBefore(prev, list);
    }

    if (!this.updated) return;

    const listStartLineAfter = root.getContentLinesRangeOf(list)![0];
    const lineDiff = listStartLineAfter - listStartLineBefore;

    const cursor = root.getCursor();
    root.replaceCursor({ line: cursor.line + lineDiff, ch: cursor.ch });

    recalculateNumericBullets(root);
  }
}
