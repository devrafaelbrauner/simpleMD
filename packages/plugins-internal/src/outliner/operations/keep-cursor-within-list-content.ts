// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/operations/KeepCursorWithinListContent.ts (cursor "grudado": nunca antes do conteúdo
// do item, nem antes da indentação das notas). Mudanças: tipos estritos.

import type { Operation } from '../model/perform';
import type { Root } from '../model/root';

export class KeepCursorWithinListContent implements Operation {
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
    const contentStart = list.getFirstLineContentStartAfterCheckbox();
    const linePrefix =
      contentStart.line === cursor.line ? contentStart.ch : list.getNotesIndent()!.length;

    if (cursor.ch < linePrefix) {
      this.updated = true;
      this.stopPropagation = true;
      root.replaceCursor({ line: cursor.line, ch: linePrefix });
    }
  }
}
