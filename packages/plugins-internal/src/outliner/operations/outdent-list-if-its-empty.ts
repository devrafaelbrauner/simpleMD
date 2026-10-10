// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/operations/OutdentListIfItsEmpty.ts (Enter num item vazio aninhado: desindenta).
// Mudanças: tipos estritos.

import type { Operation } from '../model/perform';
import type { Root } from '../model/root';
import { isEmptyLineOrEmptyCheckbox } from '../utils/checkbox';
import { OutdentList } from './outdent-list';

export class OutdentListIfItsEmpty implements Operation {
  private outdentList: OutdentList;

  constructor(private root: Root) {
    this.outdentList = new OutdentList(root);
  }

  shouldStopPropagation(): boolean {
    return this.outdentList.shouldStopPropagation();
  }

  shouldUpdate(): boolean {
    return this.outdentList.shouldUpdate();
  }

  perform(): void {
    const { root } = this;

    if (!root.hasSingleCursor()) return;

    const list = root.getListUnderCursor();
    const lines = list.getLines();

    if (lines.length > 1 || !isEmptyLineOrEmptyCheckbox(lines[0]!) || list.getLevel() === 1) return;

    this.outdentList.perform();
  }
}
