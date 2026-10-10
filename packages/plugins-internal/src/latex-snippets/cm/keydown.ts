// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/latex_suite.ts (`onKeydown`, `handleKeydown`). Mudanças: Tab e `Mod-Alt-→/←` SÓ pela
// cadeia de contexto do núcleo (`runSnippetChain`, slot `snippet`); nada em documento só leitura;
// IME por `isComposing`/`view.composing`/keyCode 229; AltGr do Windows (Ctrl+Alt) digita; com o
// popup de sugestões aberto o Enter é do popup; sem `try/catch` da fila (a expansão é uma
// transação); as opções do plugin trocam as chaves `*Enabled` do upstream.
import { completionStatus } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { contextAt, type LatexContext } from '../context';
import { findAutoFraction } from '../features/autofraction';
import { runMatrixShortcuts } from '../features/matrix-shortcuts';
import { findSnippets } from '../features/run-snippets';
import { shouldTaboutByCloseBracket, tabout } from '../features/tabout';
import { getLatexSuiteConfig, type LatexSuiteSettings } from './config';
import { expandSnippets, moveToStop } from './expand';
import { activeSession, clearStops } from './tabstops';

/**
 * Ao digitar (`Prec.highest`, depois do Vim pela ordem dos plugins): snippets `A`, fração `/`,
 * `)` sobre `)`, Enter de matriz, Backspace em `$|$`. Nada roda durante composição de IME
 * (R-I6.8). Com o popup de sugestões aberto, o Enter é do popup (arch-ux §6.4); os caracteres
 * digitados não são dele e seguem expandindo (JEV D-R7-S6-07).
 */
export function onKeydown(event: KeyboardEvent, view: EditorView): boolean {
  if (event.isComposing || view.composing || event.keyCode === 229) return false;
  if (view.state.readOnly) return false;
  const settings = getLatexSuiteConfig(view.state);
  if (!settings) return false;
  // Ctrl/⌘ = atalho (Ctrl+Z desfaz em vez de disparar um snippet terminado em `z`); fora do macOS,
  // AltGr chega como Ctrl+Alt e é digitação.
  const altGr = settings.platform !== 'mac' && event.ctrlKey && event.getModifierState('AltGraph');
  if (event.metaKey || (event.ctrlKey && !altGr)) return false;
  if (event.key === 'Enter' && completionStatus(view.state) === 'active') return false;
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
  if (
    key === 'Backspace' &&
    ctx.math &&
    ctx.math.from === ctx.math.to &&
    state.selection.main.empty
  ) {
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
  if (view.state.readOnly) return false;
  if (activeSession(view.state)) return moveToStop(view, dir);
  if (kind !== 'tab' || dir === -1) return false;
  const settings = getLatexSuiteConfig(view.state);
  const ctx = contextAt(view.state);
  if (!settings || !ctx) return false;
  const found = findSnippets(view.state, ctx, 'Tab', settings);
  if (found) return expandSnippets(view, found, null);
  if (
    settings.matrixShortcuts() &&
    ctx.mode.strictlyInMath() &&
    runMatrixShortcuts(view, ctx, 'Tab', false)
  )
    return true;
  return settings.tabout() && ctx.mode.inMath() && tabout(view, ctx);
}
