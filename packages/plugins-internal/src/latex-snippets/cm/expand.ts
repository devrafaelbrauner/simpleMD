// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/snippets/snippet_management.ts (`expandSnippets`, `setSelectionToNextTabstop`) e
// src/snippets/codemirror/snippet_queue_state_field.ts. Mudanças (JEV D-R7-S6-06): sem fila nem
// as 3–4 transações do upstream; a tecla do gatilho entra como digitação comum e a expansão
// (substituição sem marcadores, ampliação de delimitadores, paradas e seleção) é UMA transação
// isolada no histórico — Mod-Z logo depois devolve o texto do gatilho (R-I6.8); volta à parada
// anterior (R-I6.5) e anúncios "Campo i de n" (arch-ux §7.2).
import { isolateHistory } from '@codemirror/commands';
import { ChangeSet, EditorSelection, type ChangeSpec, type StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { announceStop } from '../announce';
import { autoEnlargeBrackets } from '../features/auto-enlarge-brackets';
import { getLatexSuiteConfig } from './config';
import {
  activeSession,
  groupContains,
  groupSelection,
  groupStops,
  mapSession,
  moveStops,
  parseTabstops,
  startStops,
  type StopRange,
  type TabstopSpec,
} from './tabstops';

/** Uma substituição: `[from, to]` (antes da tecla) pelo texto com marcadores de parada. */
export interface SnippetExpansion {
  readonly from: number;
  readonly to: number;
  readonly replacement: string;
  /** Visual: a tecla não entra (a seleção é envolvida). */
  readonly visual: boolean;
  /** A substituição tem `\sum`, `\frac`… (ampliação de delimitadores). */
  readonly enlarge: boolean;
}

/**
 * Aplica as expansões. `key` = a tecla que disparou (snippet `A`, `/` da fração): entra antes como
 * digitação comum, então desfazer a expansão a devolve junto com o resto do gatilho.
 */
export function expandSnippets(
  view: EditorView,
  expansions: readonly SnippetExpansion[],
  key: string | null,
): boolean {
  if (expansions.length === 0) return false;
  let specs = expansions;
  if (key !== null && !expansions.some((e) => e.visual)) {
    const typed = view.state.update(view.state.replaceSelection(key), {
      userEvent: 'input.type',
      scrollIntoView: true,
    });
    view.dispatch(typed);
    specs = expansions.map((e) => ({
      ...e,
      from: typed.changes.mapPos(e.from, -1),
      to: typed.changes.mapPos(e.to, 1),
    }));
  }
  const { state } = view;
  // Cursores cujos gatilhos se sobrepõem: vale o primeiro.
  const sorted = [...specs]
    .sort((a, b) => a.from - b.from)
    .filter((e, i, list) => i === 0 || e.from >= (list[i - 1]?.to ?? 0));
  const parsed = sorted.map((e) => parseTabstops(e.replacement));
  let changes = ChangeSet.of(
    sorted.map((e, i): ChangeSpec => ({ from: e.from, to: e.to, insert: parsed[i]?.text ?? '' })),
    state.doc.length,
  );
  const stops: TabstopSpec[] = [];
  const ends: number[] = [];
  sorted.forEach((e, i) => {
    const start = changes.mapPos(e.from, -1);
    const p = parsed[i];
    if (!p) return;
    ends.push(start + p.text.length);
    for (const stop of p.stops)
      stops.push({ number: stop.number, from: start + stop.from, to: start + stop.to });
  });
  let groups: StopRange[][] = groupStops(stops);
  let selection =
    groups[0] !== undefined
      ? groupSelection(groups[0])
      : EditorSelection.create(ends.map((pos) => EditorSelection.cursor(pos)));
  const settings = getLatexSuiteConfig(state);
  if (settings?.autoEnlargeBrackets() && sorted.some((e) => e.enlarge)) {
    const after = state.update({ changes, selection }).state;
    const enlarge = autoEnlargeBrackets(after);
    if (enlarge.length > 0) {
      const extra = ChangeSet.of(enlarge, after.doc.length);
      changes = changes.compose(extra);
      groups = groups.map((group) =>
        group.map((range) => {
          const from = extra.mapPos(range.from, 1);
          return { from, to: Math.max(from, extra.mapPos(range.to, -1)) };
        }),
      );
      selection = groups[0] !== undefined ? groupSelection(groups[0]) : selection.map(extra);
    }
  }
  // Snippet dentro de snippet: os grupos novos vêm antes dos que faltavam (como no upstream).
  const previous = activeSession(state);
  const remaining = previous ? mapSession(previous, changes).groups.slice(previous.active + 1) : [];
  const all = [...groups, ...remaining];
  const effects: StateEffect<unknown>[] =
    all.length > 1 && groups.length > 0 ? [startStops.of({ groups: all, active: 0 })] : [];
  view.dispatch({
    changes,
    selection,
    effects,
    annotations: isolateHistory.of('full'),
    userEvent: 'input.complete',
    scrollIntoView: true,
  });
  if (effects.length > 0) announceStop(view, 0, all.length);
  return true;
}

/**
 * Próxima (`dir` 1) ou anterior (-1) parada da sessão (porte de `setSelectionToNextTabstop`, com
 * volta). Sem sessão devolve `false` (a cadeia segue: célula de tabela, item de lista…). Na
 * primeira parada, "anterior" fica onde está e consome a tecla.
 */
export function moveToStop(view: EditorView, dir: 1 | -1): boolean {
  const session = activeSession(view.state);
  if (!session) return false;
  const target = session.active + dir;
  const group = session.groups[target];
  if (!group) return true;
  // Se a seleção já está dentro da parada seguinte, vai ao fim dela (upstream).
  const selection = groupSelection(group, groupContains(group, view.state.selection));
  view.dispatch({
    selection,
    effects: moveStops.of(target),
    userEvent: 'select',
    scrollIntoView: true,
  });
  announceStop(view, target, session.groups.length);
  return true;
}
