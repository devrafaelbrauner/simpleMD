// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/services/OperationPerformer.ts e src/operations/Operation.ts. Mudanças: cada operação
// aplicada vira UMA transação marcada com `userEvent` (um passo de desfazer, AC-I7.2).

import { ChangesApplicator } from './apply';
import type { MyEditor } from './editor';
import type { Parser } from './parser';
import type { Root } from './root';

export interface Operation {
  shouldStopPropagation(): boolean;
  shouldUpdate(): boolean;
  perform(): void;
}

export interface OperationResult {
  shouldUpdate: boolean;
  shouldStopPropagation: boolean;
}

export class OperationPerformer {
  private changesApplicator = new ChangesApplicator();

  constructor(private parser: Parser) {}

  eval(root: Root, op: Operation, editor: MyEditor, userEvent: string): OperationResult {
    const prevRoot = root.clone();
    op.perform();
    if (op.shouldUpdate())
      editor.transact(userEvent, () => this.changesApplicator.apply(editor, prevRoot, root));
    return { shouldUpdate: op.shouldUpdate(), shouldStopPropagation: op.shouldStopPropagation() };
  }

  perform(
    cb: (root: Root) => Operation,
    editor: MyEditor,
    userEvent: string,
    cursor = editor.getCursor(),
  ): OperationResult {
    const root = this.parser.parse(editor, cursor);
    if (!root) return { shouldUpdate: false, shouldStopPropagation: false };
    return this.eval(root, cb(root), editor, userEvent);
  }
}
