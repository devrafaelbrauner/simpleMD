// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/features/{BackspaceBehaviourOverride,DeleteBehaviourOverride,
// MetaBackspaceBehaviourOverride,ArrowLeftAndCtrlArrowLeftBehaviourOverride,
// CtrlAAndCmdABehaviourOverride}.ts. Mudanças: um keymap só; teclas por plataforma do host (o
// `Mod` do CM seguiria o navegador); `stickCursor` fixo no padrão do upstream.

import type { Extension } from '@codemirror/state';
import { keymap, type KeyBinding } from '@codemirror/view';
import type { OutlinerContext } from '../context';
import type { MyEditor } from '../model/editor';
import type { Operation } from '../model/perform';
import type { Root } from '../model/root';
import { DeleteTillCurrentLineContentStart } from '../operations/delete-till-current-line-content-start';
import { DeleteTillNextLineContentStart } from '../operations/delete-till-next-line-content-start';
import { DeleteTillPreviousLineContentEnd } from '../operations/delete-till-previous-line-content-end';
import { MoveCursorToPreviousUnfoldedLine } from '../operations/move-cursor-to-previous-unfolded-line';
import { SelectAllContent } from '../operations/select-all-content';
import { createKeymapRunCallback } from '../utils/keymap-run';

export function contentKeys(ctx: OutlinerContext): Extension {
  const sticky = () => ctx.settings.keepCursorWithinContent !== 'never';
  const binding = (
    key: string,
    op: (root: Root) => Operation,
    userEvent: string,
    check: () => boolean = sticky,
  ): KeyBinding => ({
    key,
    run: createKeymapRunCallback({
      check,
      run: (editor: MyEditor) => ctx.performer.perform(op, editor, userEvent),
    }),
  });
  const mac = ctx.platform === 'mac';
  const toPrevLine = (root: Root) => new MoveCursorToPreviousUnfoldedLine(root);
  return keymap.of([
    binding('Backspace', (root) => new DeleteTillPreviousLineContentEnd(root), 'delete.backward'),
    binding('Delete', (root) => new DeleteTillNextLineContentStart(root), 'delete.forward'),
    ...(mac
      ? [
          binding(
            'Meta-Backspace',
            (root) => new DeleteTillCurrentLineContentStart(root),
            'delete.line',
          ),
        ]
      : []),
    binding('ArrowLeft', toPrevLine, 'select'),
    ...(mac ? [] : [binding('Ctrl-ArrowLeft', toPrevLine, 'select')]),
    binding(
      mac ? 'Meta-a' : 'Ctrl-a',
      (root) => new SelectAllContent(root),
      'select',
      () => true,
    ),
  ]);
}
