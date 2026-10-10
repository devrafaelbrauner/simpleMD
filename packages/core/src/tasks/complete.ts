import type { ChangeSpec } from '@codemirror/state';
import { addDays, daysBetween, localToday } from './dates';
import { scanTaskLine, TASK_DATE_SYMBOLS, type TaskDateField, type TaskLineScan } from './line';
import { nextOccurrence, parseRecurrence } from './recurrence';
import {
  isTaskDone,
  nextTaskStatus,
  simpleTaskSemantics,
  type TaskRef,
  type TaskSemantics,
} from './semantics';

/**
 * Conclusão de tarefas de I-9 (R-I9.7; D-36; arch-frontend r7 §10.6, D-R7-F17): uma implementação
 * para o widget do editor (`taskToggleFacet`) e para o `TasksCatalog.toggleTask` do app (nota
 * aberta ou fechada).
 */

// O catálogo de tarefas do app (`apps/desktop/src/catalog/tasks-catalog.ts`, também sob demanda)
// recebe daqui o parser de linha, o "hoje" e o `noteContext`: um pedaço sob demanda que importa o
// índice do core faz o Vite partir o pedaço de entrada em vários (NFR-54, r7 S9a B1).
export { noteContext } from '../assembly/note-context';
export { localToday } from './dates';
export { parseTaskLine, sameTask } from './line';

export interface TaskCompletionOptions {
  /** Hoje no fuso local (`AAAA-MM-DD`). */
  readonly today: string;
  /** Opção "Registrar data de conclusão" (padrão ligada). */
  readonly recordDoneDate: boolean;
}

/** Uma troca dentro da linha (posições da linha crua). */
export interface LineEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface TaskLineToggle {
  /** Trocas na linha original, em ordem crescente, sem sobreposição (a próxima ocorrência entra em 0). */
  readonly edits: readonly LineEdit[];
  /** As linhas que substituem a original (recorrência: a próxima ocorrência acima, depois a concluída). */
  readonly lines: readonly string[];
  readonly status: string;
  /** Data de referência da próxima ocorrência criada (vencimento > agendada > início), se houver. */
  readonly nextDate?: string;
  /** A próxima ocorrência foi criada (com ou sem data). */
  readonly recurred: boolean;
  /** Posição do caractere de estado na linha original. */
  readonly statusOffset: number;
  /** Regra 🔁 fora do subconjunto: a tarefa só alternou (STR-145). */
  readonly unsupportedRule?: string;
}

/** Datas que a recorrência desloca, na ordem da referência (vencimento > agendada > início). */
const SHIFTED: readonly TaskDateField[] = ['due', 'scheduled', 'start'];
/** Campos que a próxima ocorrência não herda (ela nasce a fazer, sem ✅/❌, sem data de criação). */
const DROPPED: readonly TaskDateField[] = ['done', 'cancelled', 'created'];

function applyEdits(text: string, edits: readonly LineEdit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.from - a.from))
    out = out.slice(0, edit.from) + edit.insert + out.slice(edit.to);
  return out;
}

/** Trecho do campo com os espaços antes dele (para remover sem deixar espaço duplo). */
function removal(raw: string, scan: TaskLineScan, field: TaskDateField): LineEdit | null {
  const span = scan.spans[field];
  if (!span) return null;
  let from = span.from;
  while (from > scan.bodyOffset && (raw[from - 1] === ' ' || raw[from - 1] === '\t')) from--;
  return { from, to: span.to, insert: '' };
}

/** A próxima ocorrência (texto da linha) e a data de referência dela. */
function nextInstance(
  raw: string,
  scan: TaskLineScan,
  shift: (date: string) => string,
  reference: TaskDateField | undefined,
): { line: string; nextDate?: string } {
  const task = scan.task;
  const edits: LineEdit[] = [{ from: scan.statusOffset, to: scan.statusOffset + 1, insert: ' ' }];
  for (const field of DROPPED) {
    const edit = removal(raw, scan, field);
    if (edit) edits.push(edit);
  }
  let nextDate: string | undefined;
  for (const field of SHIFTED) {
    const value = task[field];
    const span = scan.spans[field];
    if (value === undefined || !span) continue;
    const shifted = shift(value);
    if (field === reference) nextDate = shifted;
    edits.push({ from: span.valueFrom, to: span.to, insert: shifted });
  }
  // O link de bloco (` ^id`) e os espaços do fim ficam só na concluída: o id é único na nota.
  const line = applyEdits(raw.slice(0, scan.bodyEnd), edits);
  return nextDate === undefined ? { line } : { line, nextDate };
}

/**
 * Alterna uma linha de tarefa com a semântica de R-I9.7, ou `null` se não é tarefa.
 * - Estado: `' '`→`x`, `x`/`X`→`' '`, `/`→`x`, `-`→`' '`, outro→`x` (UX-R7-D17).
 * - Concluir acrescenta ` ✅ AAAA-MM-DD` (com `recordDoneDate`, se ainda não há ✅ com data válida);
 *   reabrir remove esse ✅. Um ✅/❌/➕ sem data válida é texto do usuário e fica (B2).
 * - Concluir com 🔁 do subconjunto insere acima a próxima ocorrência (`[ ]`, sem ✅/❌/➕), datas
 *   deslocadas a partir das originais (ou de hoje com `when done`); regra fora → só alterna.
 */
export function toggleTaskLine(raw: string, options: TaskCompletionOptions): TaskLineToggle | null {
  const scan = scanTaskLine(raw);
  if (!scan) return null;
  const status = nextTaskStatus(scan.status);
  const completing = isTaskDone(status);
  const edits: LineEdit[] = [
    { from: scan.statusOffset, to: scan.statusOffset + 1, insert: status },
  ];
  if (completing && options.recordDoneDate && !scan.spans.done)
    edits.push({
      from: scan.bodyEnd,
      to: scan.bodyEnd,
      insert: ` ${TASK_DATE_SYMBOLS.done[0]} ${options.today}`,
    });
  if (!completing && isTaskDone(scan.status)) {
    const edit = removal(raw, scan, 'done');
    if (edit) edits.push(edit);
  }
  const completed = applyEdits(raw, edits);
  const base = { status, statusOffset: scan.statusOffset };

  const rule = scan.task.recurrence;
  if (!completing || rule === undefined)
    return { ...base, edits, lines: [completed], recurred: false };
  const parsed = parseRecurrence(rule);
  if (!parsed)
    return { ...base, edits, lines: [completed], recurred: false, unsupportedRule: rule };

  const reference = SHIFTED.find((field) => scan.task[field] !== undefined);
  const original = reference === undefined ? undefined : (scan.task[reference] as string);
  let shift: (date: string) => string = (date) => date;
  if (original !== undefined) {
    const target = nextOccurrence(parsed, parsed.whenDone ? options.today : original);
    shift = (date) => addDays(target, daysBetween(original, date));
  }
  const next = nextInstance(raw, scan, shift, reference);
  return {
    ...base,
    edits: [{ from: 0, to: 0, insert: `${next.line}\n` }, ...edits],
    lines: [next.line, completed],
    recurred: true,
    ...(next.nextDate === undefined ? {} : { nextDate: next.nextDate }),
  };
}

export interface TaskCompletionSemanticsOptions {
  readonly recordDoneDate: () => boolean;
  /** Relógio injetável (testes); padrão {@link localToday}. */
  readonly today?: () => string;
  /** Regra 🔁 fora do subconjunto: o app mostra STR-145 nomeando a regra. */
  readonly onUnsupportedRule?: (rule: string) => void;
}

/**
 * Semântica de R-I9.7 para o `taskToggleFacet` (o registro do `simplemd.tasks` a compõe por
 * `host.editor.taskSemantics`): uma transação, um passo de desfazer; anúncios STR-144.
 */
export function taskCompletionSemantics(options: TaskCompletionSemanticsOptions): TaskSemantics {
  return (state, tasks) => {
    const today = options.today?.() ?? localToday();
    const recordDoneDate = options.recordDoneDate();
    const changes: ChangeSpec[] = [];
    const fallback: TaskRef[] = [];
    let single: TaskLineToggle | null = null;
    for (const ref of tasks) {
      const line = state.doc.lineAt(ref.markerFrom);
      const toggle = toggleTaskLine(line.text, { today, recordDoneDate });
      // A árvore viu uma tarefa que a linha sozinha não descreve (ex.: item dentro de outro
      // contêiner): troca só o caractere, como a semântica simples.
      if (!toggle || line.from + toggle.statusOffset !== ref.markerFrom + 1) {
        fallback.push(ref);
        continue;
      }
      single = toggle;
      for (const edit of toggle.edits)
        changes.push({ from: line.from + edit.from, to: line.from + edit.to, insert: edit.insert });
      if (toggle.unsupportedRule !== undefined) options.onUnsupportedRule?.(toggle.unsupportedRule);
    }
    if (fallback.length > 0) changes.push(...simpleTaskSemantics(state, fallback).changes);
    let announce: string | null = null;
    if (tasks.length > 1) announce = `${tasks.length} tarefas alternadas.`;
    else if (single?.recurred && single.nextDate !== undefined)
      announce = `Tarefa concluída. Próxima repetição criada para ${single.nextDate}.`;
    else if (tasks[0])
      announce = isTaskDone(single?.status ?? nextTaskStatus(tasks[0].status))
        ? 'Tarefa concluída.'
        : 'Tarefa reaberta.';
    return { changes, announce };
  };
}
