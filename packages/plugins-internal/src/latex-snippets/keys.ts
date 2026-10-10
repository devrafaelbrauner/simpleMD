import { completionStatus } from '@codemirror/autocomplete';
import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { InternalCommand, InternalHostContext } from '@simplemd/plugin-api/internal/host';
import { LATEX_TEXT } from './announce';
import { getLatexSuiteConfig, type LatexSuiteSettings } from './cm/config';
import { expandSnippets, moveToStop } from './cm/expand';
import { activeSession, clearStops } from './cm/tabstops';
import { contextAt, type LatexContext } from './context';
import { findAutoFraction } from './features/autofraction';
import { runMatrixShortcuts } from './features/matrix-shortcuts';
import { findSnippets } from './features/run-snippets';
import { shouldTaboutByCloseBracket, tabout } from './features/tabout';

/**
 * Teclas dos snippets LaTeX (r7 I-6; arch-frontend §4.2 camada 5 e §10.3; reescrito do
 * `latex_suite.ts` do upstream). Ao digitar (`Prec.highest`, depois do Vim pela ordem dos
 * plugins): snippets `A`, fração `/`, `)` sobre `)`, Enter de matriz, Backspace em `$|$`. Tab e
 * `Mod-Alt-→/←` SÓ pela cadeia de contexto (slot `snippet`, 400); Esc pelo árbitro (`snippet`).
 * Nada roda durante composição de IME (R-I6.8) nem com o popup de sugestões aberto.
 */
export function onKeydown(event: KeyboardEvent, view: EditorView): boolean {
  if (event.isComposing || view.composing || event.keyCode === 229) return false;
  if (event.ctrlKey || event.metaKey) return false;
  if (completionStatus(view.state) === 'active') return false;
  const settings = getLatexSuiteConfig(view.state);
  if (!settings) return false;
  const ctx = contextAt(view.state);
  if (!ctx) return false;
  const handled = handleKey(view, ctx, settings, event.key, event.shiftKey);
  if (handled) event.preventDefault();
  return handled;
}

function handleKey(
  view: EditorView,
  ctx: LatexContext,
  settings: LatexSuiteSettings,
  key: string,
  shiftKey: boolean,
): boolean {
  const { state } = view;
  // Backspace dentro de `$|$` apaga os dois `$` (`autoDelete$` do upstream).
  if (key === 'Backspace' && ctx.math && ctx.math.from === ctx.math.to && state.selection.main.empty) {
    const pos = ctx.pos;
    if (state.sliceDoc(pos - 1, pos + 1) === '$$') {
      view.dispatch({
        changes: { from: pos - 1, to: pos + 1 },
        effects: clearStops.of(null),
        userEvent: 'delete.backward',
      });
      return true;
    }
  }
  if (key.length === 1) {
    const found = findSnippets(state, ctx, key, settings);
    if (found) return expandSnippets(view, found, key);
    if (key === '/' && settings.autofraction() && ctx.mode.strictlyInMath()) {
      const fraction = findAutoFraction(state, ctx);
      if (fraction) return expandSnippets(view, fraction, key);
    }
    if (settings.tabout() && ctx.mode.inMath() && shouldTaboutByCloseBracket(state, key))
      return tabout(view, ctx);
    return false;
  }
  if (key === 'Enter' && settings.matrixShortcuts() && ctx.mode.strictlyInMath())
    return runMatrixShortcuts(view, ctx, 'Enter', shiftKey);
  return false;
}

/**
 * Slot `snippet` da cadeia (arch-frontend §4.4): paradas ativas → próxima/anterior; senão, só no
 * Tab (chave ligada): snippet não automático → matriz ` & ` → tabout (ordem do upstream, JEV
 * D-R7-S6-05). `Mod-Alt-→/←` só percorre paradas.
 */
export function runSnippetChain(view: EditorView, dir: 1 | -1, kind: string): boolean {
  if (activeSession(view.state)) return moveToStop(view, dir);
  if (kind !== 'tab' || dir === -1) return false;
  const settings = getLatexSuiteConfig(view.state);
  const ctx = contextAt(view.state);
  if (!settings || !ctx) return false;
  const found = findSnippets(view.state, ctx, 'Tab', settings);
  if (found) return expandSnippets(view, found, null);
  if (settings.matrixShortcuts() && ctx.mode.strictlyInMath() && runMatrixShortcuts(view, ctx, 'Tab', false))
    return true;
  return settings.tabout() && ctx.mode.inMath() && tabout(view, ctx);
}

/** "Expandir snippet LaTeX" (`Mod-Shift-E`, R-I6.4): snippet não automático sob o cursor. */
export function expandCommand(view: EditorView): boolean {
  const settings = getLatexSuiteConfig(view.state);
  if (!settings) return false;
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
  { id: `${PLUGIN_ID}:expand`, title: LATEX_TEXT.expand, hotkey: 'Mod-Shift-e', run: expandCommand },
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
