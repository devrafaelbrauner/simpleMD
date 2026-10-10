// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/features/EditorSelectionsBehaviourOverride.ts (cursor fora das linhas dobradas e
// "grudado" no conteúdo do item depois de qualquer mudança de seleção). Mudanças: `ViewPlugin` no
// lugar do `transactionExtender` (mesmo adiamento de 0 ms; nada roda depois de destruído).

import type { Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import type { OutlinerContext } from '../context';
import { MyEditor } from '../model/editor';
import { KeepCursorOutsideFoldedLines } from '../operations/keep-cursor-outside-folded-lines';
import { KeepCursorWithinListContent } from '../operations/keep-cursor-within-list-content';

export function selectionsBehaviour(ctx: OutlinerContext): Extension {
  return ViewPlugin.define((view: EditorView) => {
    let timer = 0;

    const handleSelectionsChanges = () => {
      timer = 0;
      if (view.composing) return;
      const editor = new MyEditor(view);
      const root = ctx.parser.parse(editor);
      if (!root) return;
      const outside = ctx.performer.eval(
        root,
        new KeepCursorOutsideFoldedLines(root),
        editor,
        'select',
      );
      if (outside.shouldStopPropagation) return;
      ctx.performer.eval(root, new KeepCursorWithinListContent(root), editor, 'select');
    };

    return {
      update(update: ViewUpdate) {
        if (ctx.settings.keepCursorWithinContent === 'never') return;
        if (!update.transactions.some((tr) => tr.selection)) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(handleSelectionsChanges, 0);
      },
      destroy() {
        window.clearTimeout(timer);
      },
    };
  });
}
