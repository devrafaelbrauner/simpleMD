// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/operations/SelectAllContent.ts (Mod-A em etapas: conteúdo do item → item com os
// subitens → lista inteira; depois o "selecionar tudo" do editor). Mudanças: tipos estritos.

import type { Operation } from '../model/perform';
import { maxPos, minPos, type Root } from '../model/root';

export class SelectAllContent implements Operation {
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

    if (!root.hasSingleSelection()) return;

    const selection = root.getSelections()[0]!;
    const [rootStart, rootEnd] = root.getContentRange();

    const selectionFrom = minPos(selection.anchor, selection.head);
    const selectionTo = maxPos(selection.anchor, selection.head);

    if (selectionFrom.line < rootStart.line || selectionTo.line > rootEnd.line) return;

    if (
      selectionFrom.line === rootStart.line &&
      selectionFrom.ch === rootStart.ch &&
      selectionTo.line === rootEnd.line &&
      selectionTo.ch === rootEnd.ch
    )
      return;

    const list = root.getListUnderCursor();
    const contentStart = list.getFirstLineContentStartAfterCheckbox();
    const contentEnd = list.getLastLineContentEnd();
    const listUnderSelectionFrom = root.getListUnderLine(selectionFrom.line)!;
    const listStart = listUnderSelectionFrom.getFirstLineContentStartAfterCheckbox();
    const listEnd = listUnderSelectionFrom.getContentEndIncludingChildren();

    this.stopPropagation = true;
    this.updated = true;

    if (
      selectionFrom.line === contentStart.line &&
      selectionFrom.ch === contentStart.ch &&
      selectionTo.line === contentEnd.line &&
      selectionTo.ch === contentEnd.ch
    ) {
      if (list.getChildren().length) {
        // Item com os subitens.
        root.replaceSelections([
          { anchor: contentStart, head: list.getContentEndIncludingChildren() },
        ]);
      } else {
        // Lista inteira.
        root.replaceSelections([{ anchor: rootStart, head: rootEnd }]);
      }
    } else if (
      listStart.ch == selectionFrom.ch &&
      listEnd.line == selectionTo.line &&
      listEnd.ch == selectionTo.ch
    ) {
      // Lista inteira.
      root.replaceSelections([{ anchor: rootStart, head: rootEnd }]);
    } else if (
      (selectionFrom.line > contentStart.line ||
        (selectionFrom.line == contentStart.line && selectionFrom.ch >= contentStart.ch)) &&
      (selectionTo.line < contentEnd.line ||
        (selectionTo.line == contentEnd.line && selectionTo.ch <= contentEnd.ch))
    ) {
      // Conteúdo do item.
      root.replaceSelections([{ anchor: contentStart, head: contentEnd }]);
    } else {
      this.stopPropagation = false;
      this.updated = false;
    }
  }
}
