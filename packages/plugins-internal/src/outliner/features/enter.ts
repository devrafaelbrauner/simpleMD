// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/features/EnterBehaviourOverride.ts. Mudanças: sem `Plugin`/`Settings` do Obsidian
// (sempre ligado com o plugin); unidade de indentação detectada (R-I7.5); sem Zoom; o Enter
// padrão do Obsidian num item vazio de nível 1 (encerra a lista: a linha fica vazia), de que os
// casos-ouro dependem, é feito aqui (o `lang-markdown` do simpleMD não encerra; D-R7-S7-03).

import { Prec, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { defaultIndentChars, type OutlinerContext } from '../context';
import type { MyEditor } from '../model/editor';
import type { OperationResult } from '../model/perform';
import { CreateNewItem } from '../operations/create-new-item';
import { OutdentListIfItsEmpty } from '../operations/outdent-list-if-its-empty';
import { isEmptyLineOrEmptyCheckbox } from '../utils/checkbox';
import { createKeymapRunCallback } from '../utils/keymap-run';

const NO_ZOOM = { getZoomRange: () => null };

export function enterBehaviour(ctx: OutlinerContext): Extension {
  const run = (editor: MyEditor): OperationResult => {
    const root = ctx.parser.parse(editor);
    if (!root) return { shouldUpdate: false, shouldStopPropagation: false };

    const outdent = ctx.performer.eval(root, new OutdentListIfItsEmpty(root), editor, 'input');
    if (outdent.shouldStopPropagation) return outdent;

    const created = ctx.performer.eval(
      root,
      new CreateNewItem(root, defaultIndentChars(editor.state), NO_ZOOM),
      editor,
      'input',
    );
    if (created.shouldUpdate || created.shouldStopPropagation || !root.hasSingleCursor())
      return created;

    // Item vazio de nível 1: encerra a lista (comportamento padrão do Obsidian no upstream).
    const list = root.getListUnderCursor();
    const lines = list.getLines();
    if (lines.length > 1 || !isEmptyLineOrEmptyCheckbox(lines[0]!) || list.getLevel() !== 1)
      return created;
    const { line } = list.getFirstLineContentStart();
    const end = list.getLastLineContentEnd();
    editor.transact('input', () => {
      editor.replaceRange('', { line, ch: 0 }, end);
      editor.setSelections([{ anchor: { line, ch: 0 }, head: { line, ch: 0 } }]);
    });
    return { shouldUpdate: true, shouldStopPropagation: true };
  };
  return Prec.highest(keymap.of([{ key: 'Enter', run: createKeymapRunCallback({ run }) }]));
}
