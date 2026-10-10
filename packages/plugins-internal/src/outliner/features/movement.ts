// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/features/ListsMovementCommands.ts, src/features/TabBehaviourOverride.ts e
// src/features/ShiftTabBehaviourOverride.ts. Mudanças: teclas de mover da UX (UX-R7-D6:
// ⌃⌘↑/↓ no macOS, Ctrl-Shift-↑/↓ nos demais); Tab/Shift-Tab e `Mod-]`/`Mod-[` só pela cadeia de
// contexto do núcleo (slot `list`, prioridade 10); anúncio de cada movimento (arch-ux §7.2).

import type { EditorView, KeyBinding } from '@codemirror/view';
import { defaultIndentChars, type OutlinerContext } from '../context';
import { MyEditor } from '../model/editor';
import type { Operation } from '../model/perform';
import type { Root } from '../model/root';
import { IndentList } from '../operations/indent-list';
import { MoveListDown } from '../operations/move-list-down';
import { MoveListUp } from '../operations/move-list-up';
import { OutdentList } from '../operations/outdent-list';
import { OUTLINER_TEXT } from '../text';

export type MovementId = 'move-up' | 'move-down' | 'indent' | 'outdent';

/**
 * Executa um movimento no item sob o cursor: `true` quando a tecla é do outliner (item de lista com
 * um cursor só), mesmo que nada mude (ex.: primeiro item não indenta, como no upstream).
 */
export function runMovement(ctx: OutlinerContext, view: EditorView, id: MovementId): boolean {
  if (view.composing) return false;
  const editor = new MyEditor(view);
  const spec: Record<MovementId, [(root: Root) => Operation, string, string]> = {
    'move-up': [(root) => new MoveListUp(root), 'move.line', OUTLINER_TEXT.movedUp],
    'move-down': [(root) => new MoveListDown(root), 'move.line', OUTLINER_TEXT.movedDown],
    indent: [
      (root) => new IndentList(root, defaultIndentChars(view.state)),
      'indent.more',
      OUTLINER_TEXT.indented,
    ],
    outdent: [(root) => new OutdentList(root), 'indent.less', OUTLINER_TEXT.outdented],
  };
  const [op, userEvent, announcement] = spec[id];
  const result = ctx.performer.perform(op, editor, userEvent);
  if (result.shouldUpdate) ctx.announce(announcement);
  return result.shouldUpdate || result.shouldStopPropagation;
}

/** Teclas de mover item (Classe A, arch-ux §6.2) na plataforma do host. */
export function moveKeys(platform: 'mac' | 'other'): { up: string; down: string } {
  return platform === 'mac'
    ? { up: 'Ctrl-Meta-ArrowUp', down: 'Ctrl-Meta-ArrowDown' }
    : { up: 'Ctrl-Shift-ArrowUp', down: 'Ctrl-Shift-ArrowDown' };
}

export function movementBindings(ctx: OutlinerContext): KeyBinding[] {
  const keys = moveKeys(ctx.platform);
  return [
    { key: keys.up, run: (view) => runMovement(ctx, view, 'move-up') },
    { key: keys.down, run: (view) => runMovement(ctx, view, 'move-down') },
  ];
}
