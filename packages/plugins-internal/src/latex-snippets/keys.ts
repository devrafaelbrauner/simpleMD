import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { InternalCommand, InternalHostContext } from '@simplemd/plugin-api/internal/host';
import { LATEX_TEXT } from './announce';
import { getLatexSuiteConfig } from './cm/config';
import { expandSnippets, moveToStop } from './cm/expand';
import { onKeydown, runSnippetChain } from './cm/keydown';
import { activeSession, clearStops } from './cm/tabstops';
import { contextAt } from './context';
import { findSnippets } from './features/run-snippets';

/*
 * Teclas dos snippets LaTeX (r7 I-6; arch-frontend §4.2 camada 5 e §10.3): a digitação e a cadeia
 * do Tab são o porte do `latex_suite.ts` em `cm/keydown.ts`; aqui ficam o comando "Expandir
 * snippet LaTeX", o Esc pelo árbitro (`snippet`), a paleta e a ligação com o host. Tab e
 * `Mod-Alt-→/←` SÓ pela cadeia de contexto (slot `snippet`, 400).
 */

/** "Expandir snippet LaTeX" (`Mod-Shift-E`, R-I6.4): snippet não automático sob o cursor. */
export function expandCommand(view: EditorView): boolean {
  const settings = getLatexSuiteConfig(view.state);
  if (!settings || view.state.readOnly) return false;
  const ctx = contextAt(view.state);
  const found = ctx && findSnippets(view.state, ctx, 'Tab', settings);
  if (found) return expandSnippets(view, found, null);
  settings.announce(LATEX_TEXT.nothingToExpand);
  return true;
}

/** Esc com paradas ativas: encerra e anuncia (árbitro do núcleo, dono `snippet`). */
export function endStops(view: EditorView): boolean {
  if (!activeSession(view.state)) return false;
  view.dispatch({ effects: clearStops.of(null) });
  getLatexSuiteConfig(view.state)?.announce(LATEX_TEXT.fieldsEnded);
  return true;
}

const PLUGIN_ID = 'simplemd.latex-snippets';

/** Comandos da paleta (STR-172; arch-ux §3.7), pelo privilégio `host.palette` (JEV D-R7-M05). */
export const LATEX_COMMANDS: readonly InternalCommand[] = [
  {
    id: `${PLUGIN_ID}:expand`,
    title: LATEX_TEXT.expand,
    hotkey: 'Mod-Shift-e',
    run: expandCommand,
  },
  {
    id: `${PLUGIN_ID}:next-field`,
    title: LATEX_TEXT.nextField,
    hotkey: 'Mod-Alt-ArrowRight',
    run: (view) => moveToStop(view, 1),
  },
  {
    id: `${PLUGIN_ID}:prev-field`,
    title: LATEX_TEXT.prevField,
    hotkey: 'Mod-Alt-ArrowLeft',
    run: (view) => moveToStop(view, -1),
  },
];

/** Tudo o que liga as teclas do plugin ao editor e ao núcleo (pelo contexto privado do host). */
export function latexKeys(host: InternalHostContext): Extension[] {
  return [
    Prec.highest(EditorView.domEventHandlers({ keydown: onKeydown })),
    host.editor.contextAction('snippet', { kinds: ['tab', 'move'], run: runSnippetChain }),
    host.editor.escape('snippet', endStops),
    keymap.of([{ key: 'Mod-Shift-e', run: expandCommand }]),
    ...(host.palette ? [host.palette(LATEX_COMMANDS)] : []),
  ];
}
