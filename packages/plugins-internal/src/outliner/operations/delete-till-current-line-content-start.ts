// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/operations/DeleteTillCurrentLineContentStart.ts (⌘⌫: apaga até o início do conteúdo,
// nunca o marcador). Mudanças: tipos estritos.

import type { Operation } from '../model/perform';
import type { Root } from '../model/root';

export class DeleteTillCurrentLineContentStart implements Operation {
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
    this.updated = true;

    const cursor = root.getCursor();
    const list = root.getListUnderCursor();
    const lines = list.getLinesInfo();
    const line = lines.find((l) => l.from.line === cursor.line)!;

    line.text = line.text.slice(cursor.ch - line.from.ch);

    list.replaceLines(lines.map((l) => l.text));
    root.replaceCursor(line.from);
  }
}
