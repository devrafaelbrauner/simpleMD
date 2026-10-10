// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/utils/createKeymapRunCallback.ts. Mudanças: o editor vem do próprio `EditorView`
// (sem `editorInfoField` do Obsidian); a checagem de IME do `IMEDetector` virou `view.composing`.

import type { EditorView } from '@codemirror/view';
import { MyEditor } from '../model/editor';
import type { OperationResult } from '../model/perform';

export function createKeymapRunCallback(config: {
  check?: (editor: MyEditor) => boolean;
  run: (editor: MyEditor) => OperationResult;
}): (view: EditorView) => boolean {
  const check = config.check ?? (() => true);
  const { run } = config;

  return (view: EditorView): boolean => {
    // Durante a composição de IME a tecla é do IME (R-I4.6, arch-frontend §4.3).
    if (view.composing) return false;
    const editor = new MyEditor(view);
    if (!check(editor)) return false;
    const { shouldUpdate, shouldStopPropagation } = run(editor);
    return shouldUpdate || shouldStopPropagation;
  };
}
