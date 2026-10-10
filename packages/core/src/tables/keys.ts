import { completionStatus } from '@codemirror/autocomplete';
import { insertNewline } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { Prec, type Extension } from '@codemirror/state';
import { keymap, ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { contextAction } from '../keys/context-chain';
import { runTableCommand, tableAt } from './commands';
import { prefetchTableEngine, tablePrefetchSettled } from './engine';

/** O cursor está numa tabela de topo e a tecla é para a tabela (não IME, nem popup, nem leitura). */
function inTopTable(view: EditorView): boolean {
  const { state } = view;
  if (state.readOnly || view.composing || completionStatus(state) === 'active') return false;
  return tableAt(state, state.selection.main.head)?.kind === 'top';
}

/**
 * Slot `table` (300) da cadeia de contexto (arch-frontend r7 §4.4): Tab/Shift-Tab (só com
 * `editor.captureTab`) e `Mod-Alt-→/←` (sempre) vão à próxima/anterior célula, formatando; na
 * última célula cria linha. Fora de tabela de topo segue a cadeia (item de lista > indentação).
 */
export const tableContextAction: Extension = contextAction('table', {
  kinds: ['tab', 'move'],
  run(view, dir) {
    if (!inTopTable(view)) return false;
    runTableCommand(view, dir === 1 ? 'next-cell' : 'prev-cell');
    return true;
  },
});

/**
 * Classe B na tabela (D-43, arch-ux §6.4): Enter = próxima linha na mesma coluna (cria no fim,
 * formata), sempre; Shift-Enter = quebra de linha comum. `Mod-Shift-F` = "Formatar tabela" (Classe
 * A do editor, UX-R7-D20): fora de tabela mostra o aviso e não muda nada.
 */
export const tableKeymap: Extension = Prec.high(
  keymap.of([
    {
      key: 'Enter',
      run: (view) => inTopTable(view) && runTableCommand(view, 'next-row'),
      shift: (view) => inTopTable(view) && insertNewline(view),
    },
    {
      key: 'Mod-Shift-f',
      run: (view) => {
        if (view.state.readOnly) return false;
        runTableCommand(view, 'format');
        return true;
      },
    },
  ]),
);

/**
 * Pré-carga do pedaço `tables-engine` (arch-frontend r7 §7): quando uma tabela de topo aparece na
 * área visível ou o cursor entra numa tabela. Depois que o motor carregou, ou se a carga falhou,
 * não faz mais nada (sem nova tentativa a cada tecla; um comando de tabela tenta de novo).
 */
export const tablePrefetch: Extension = ViewPlugin.define((view) => {
  const check = (target: EditorView) => {
    if (tablePrefetchSettled()) return;
    let found = tableAt(target.state, target.state.selection.main.head) !== null;
    const tree = syntaxTree(target.state);
    for (const { from, to } of target.visibleRanges) {
      if (found) break;
      tree.iterate({
        from,
        to,
        enter(node) {
          if (node.name === 'Document') return undefined;
          if (node.name === 'Table') found = true;
          return false;
        },
      });
    }
    if (found) prefetchTableEngine();
  };
  check(view);
  return {
    update(update: ViewUpdate) {
      if (tablePrefetchSettled()) return;
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        check(update.view);
    },
  };
});
