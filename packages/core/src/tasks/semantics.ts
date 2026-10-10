import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { Facet, Prec, type ChangeSpec, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, type Command } from '@codemirror/view';

/** Uma linha de tarefa: posição de `[c]` e o caractere de estado `c` (R-I1.3, R-I9.2). */
export interface TaskRef {
  /** Início de `[` no documento. */
  readonly markerFrom: number;
  /** Caractere entre os colchetes (`' '`, `x`, `X`, `-`, `/`, outro). */
  readonly status: string;
}

/** Resultado de uma alternância: as mudanças (uma transação = um passo de desfazer) e o anúncio. */
export interface TaskToggleResult {
  readonly changes: readonly ChangeSpec[];
  /** STR-144 (só para o teclado); `null` = nada a anunciar. */
  readonly announce: string | null;
}

/**
 * Semântica da conclusão (ponto de extensão de R-I1.3): o padrão troca só o caractere; o plugin
 * `simplemd.tasks` (S9) registra a de R-I9.7 (✅ e recorrência) por `host.editor.taskSemantics`.
 */
export type TaskSemantics = (state: EditorState, tasks: readonly TaskRef[]) => TaskToggleResult;

/**
 * Próximo estado na alternância simples (UX-R7-D17): `' '`→`x`, `x`/`X`→`' '`, `/`→`x`, `-`→`' '`,
 * qualquer outro → `x`.
 */
export function nextTaskStatus(status: string): string {
  return status === 'x' || status === 'X' || status === '-' ? ' ' : 'x';
}

/** Tarefa feita? (`aria-checked="true"` e o anúncio "Tarefa concluída."). */
export function isTaskDone(status: string): boolean {
  return status === 'x' || status === 'X';
}

/** Semântica padrão (I-9 desligado): troca um caractere por outro, um byte por tarefa (AC-I1.5). */
export const simpleTaskSemantics: TaskSemantics = (_state, tasks) => {
  const changes = tasks.map((task) => ({
    from: task.markerFrom + 1,
    to: task.markerFrom + 2,
    insert: nextTaskStatus(task.status),
  }));
  let announce: string | null = null;
  if (tasks.length > 1) announce = `${tasks.length} tarefas alternadas.`;
  else if (tasks[0])
    announce = isTaskDone(nextTaskStatus(tasks[0].status))
      ? 'Tarefa concluída.'
      : 'Tarefa reaberta.';
  return { changes, announce };
};

/** A semântica em vigor: a última registrada vence; sem registro, {@link simpleTaskSemantics}. */
export const taskToggleFacet = Facet.define<TaskSemantics, TaskSemantics>({
  combine: (values) => values[values.length - 1] ?? simpleTaskSemantics,
});

/** Tarefas (`TaskMarker`) das linhas tocadas por `[from, to]`, na ordem do documento. */
export function tasksInLines(state: EditorState, from: number, to: number): TaskRef[] {
  const doc = state.doc;
  const start = doc.lineAt(from).from;
  const end = doc.lineAt(to).to;
  const tree = ensureSyntaxTree(state, end, 50) ?? syntaxTree(state);
  const tasks: TaskRef[] = [];
  tree.iterate({
    from: start,
    to: end,
    enter: (node) => {
      if (node.name !== 'TaskMarker' || node.from < start || node.from > end) return;
      tasks.push({ markerFrom: node.from, status: doc.sliceString(node.from + 1, node.from + 2) });
    },
  });
  return tasks;
}

/**
 * Alterna as tarefas dadas numa transação só (um passo de desfazer). `announce` liga o anúncio
 * pela região do editor (só para gestos de teclado; o clique é um gesto visual).
 */
export function toggleTasks(view: EditorView, tasks: readonly TaskRef[], announce: boolean): void {
  const result = view.state.facet(taskToggleFacet)(view.state, tasks);
  view.dispatch({
    changes: [...result.changes],
    userEvent: 'input.task',
    ...(announce && result.announce !== null
      ? { effects: EditorView.announce.of(result.announce) }
      : {}),
  });
}

/**
 * "Alternar tarefa" (`task:toggle`, `Mod-L`; R-I1.3, UX-R7-D9): alterna todas as linhas de tarefa
 * tocadas pela seleção, num passo de desfazer, com o anúncio STR-144. Sem tarefa → 0 mudanças e
 * "Nenhuma tarefa na seleção.".
 */
export const toggleTaskCommand: Command = (view) => {
  if (view.state.readOnly) return false;
  const seen = new Set<number>();
  const tasks: TaskRef[] = [];
  for (const range of view.state.selection.ranges) {
    for (const task of tasksInLines(view.state, range.from, range.to)) {
      if (seen.has(task.markerFrom)) continue;
      seen.add(task.markerFrom);
      tasks.push(task);
    }
  }
  if (tasks.length === 0) {
    view.dispatch({ effects: EditorView.announce.of('Nenhuma tarefa na seleção.') });
    return true;
  }
  toggleTasks(
    view,
    tasks.sort((a, b) => a.markerFrom - b.markerFrom),
    true,
  );
  return true;
};

/** `Mod-L` no núcleo (`Prec.high`, arch-frontend §4.2 camada 9). */
export function taskKeymap(): Extension {
  return Prec.high(keymap.of([{ key: 'Mod-l', run: toggleTaskCommand }]));
}
