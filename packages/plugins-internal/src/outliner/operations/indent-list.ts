// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/operations/IndentList.ts (indenta o item com a subárvore sob o irmão anterior, com a
// unidade de indentação já usada na lista). Mudanças: tipos estritos.

import type { Operation } from '../model/perform';
import { recalculateNumericBullets, type Root } from '../model/root';

export class IndentList implements Operation {
  private stopPropagation = false;
  private updated = false;

  constructor(
    private root: Root,
    private defaultIndentChars: string,
  ) {}

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
    const prev = parent.getPrevSiblingOf(list);

    if (!prev) return;

    this.updated = true;

    const listStartLineBefore = root.getContentLinesRangeOf(list)![0];

    const indentPos = list.getFirstLineIndent().length;
    let indentChars = '';

    const prevFirstChild = prev.getChildren()[0];
    if (indentChars === '' && prevFirstChild)
      indentChars = prevFirstChild.getFirstLineIndent().slice(prev.getFirstLineIndent().length);

    if (indentChars === '')
      indentChars = list.getFirstLineIndent().slice(parent.getFirstLineIndent().length);

    const listFirstChild = list.getChildren()[0];
    if (indentChars === '' && listFirstChild) indentChars = listFirstChild.getFirstLineIndent();

    if (indentChars === '') indentChars = this.defaultIndentChars;

    parent.removeChild(list);
    prev.addAfterAll(list);
    list.indentContent(indentPos, indentChars);

    const listStartLineAfter = root.getContentLinesRangeOf(list)![0];
    const lineDiff = listStartLineAfter - listStartLineBefore;

    const cursor = root.getCursor();
    root.replaceCursor({ line: cursor.line + lineDiff, ch: cursor.ch + indentChars.length });

    recalculateNumericBullets(root);
  }
}
