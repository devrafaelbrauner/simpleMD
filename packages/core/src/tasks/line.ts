// Portado de obsidian-tasks-group/obsidian-tasks@9173205606e49846f456caf438fdc0e5baded77e (MIT), © 2021 Clare Macrae, Ilyas Landikov and Martin Schenck. Modificado para o simpleMD.
// Origem: src/Task/TaskRegularExpressions.ts (indentação, marcador de lista, caixa, tags, link de
// bloco), a tabela de símbolos e as expressões dos campos de src/TaskSerializer/DefaultTaskSerializer.ts
// (laço que retira os campos do fim da linha, até 20 rodadas, com as tags do fim preservadas) e
// src/Task/Priority.ts. Mudanças: sem `moment` (datas como texto `AAAA-MM-DD` validadas no
// calendário), data inválida marcada em vez de ficar na descrição, posições de cada campo na linha
// (para a conclusão editar no lugar), só os sinais de R-I9.2 (sem 🆔/⛔/🏁), caixa com um caractere
// seguido de espaço ou tab (a mesma regra da árvore, `tasks/syntax.ts`) e prioridade numérica 0–5.
import { isValidTaskDate } from './dates';

/** Campos de data de uma tarefa (sinais 📅 ⏳ 🛫 ➕ ✅ ❌; R-I9.2). */
export type TaskDateField = 'due' | 'scheduled' | 'start' | 'created' | 'done' | 'cancelled';

/** 0 ⏬ mínima, 1 🔽 baixa, 2 sem prioridade, 3 🔼 média, 4 ⏫ alta, 5 🔺 máxima. */
export type TaskPriority = 0 | 1 | 2 | 3 | 4 | 5;

/** Tarefa lida de uma linha (forma do índice v3 e do `TasksCatalog`; arch-backend r7 §1.8). */
export interface ParsedTask {
  /** 0-based no texto normalizado; `-1` quando a linha veio solta. */
  readonly line: number;
  readonly status: string;
  readonly text: string;
  readonly due?: string;
  readonly scheduled?: string;
  readonly start?: string;
  readonly created?: string;
  readonly done?: string;
  readonly cancelled?: string;
  readonly priority: TaskPriority;
  readonly recurrence?: string;
  readonly tags: readonly string[];
  readonly invalid: readonly TaskDateField[];
}

/** Descrição guardada (R-I9.3): o resto é cortado, igual no indexador e na conferência da linha. */
export const TASK_TEXT_MAX = 1000;
/** Regra de recorrência guardada. */
export const TASK_RECURRENCE_MAX = 200;
/** Prioridade quando a linha não tem sinal. */
export const NO_PRIORITY: TaskPriority = 2;

/** Sinal de cada campo de data (o primeiro de cada lista é o que a conclusão escreve). */
export const TASK_DATE_SYMBOLS: Readonly<Record<TaskDateField, readonly string[]>> = {
  due: ['📅', '📆', '🗓'],
  scheduled: ['⏳', '⌛'],
  start: ['🛫'],
  created: ['➕'],
  done: ['✅'],
  cancelled: ['❌'],
};

const PRIORITY_SYMBOLS: Readonly<Record<string, TaskPriority>> = {
  '🔺': 5,
  '⏫': 4,
  '🔼': 3,
  '🔽': 1,
  '⏬': 0,
};

/**
 * Linha de tarefa: indentação (com `>` de citação e marcadores de listas de fora, como em
 * `- - [ ] a`), marcador `-`/`*`/`+`/`1.`/`1)`, espaços, `[c]` e espaço ou tab. `c` é uma unidade
 * UTF-16 que não é `]` (como o `TASK` de `tasks/syntax.ts`). Cada marcador de fora começa por um
 * marcador e UM espaço ou tab (`[ \t][ \t>]*`, não `[ \t]+[ \t>]*`): uma sequência de espaços tem
 * uma só divisão, então uma linha que não casa custa tempo polinomial, não exponencial (r7 S9a B3).
 */
const TASK_LINE =
  /^([ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t][ \t>]*)*?)([-*+]|\d{1,9}[.)])([ \t]+)\[([^\]\n\r])\][ \t]/;

// Campos do fim do corpo (DefaultTaskSerializer). Uma data é o "token" depois do sinal: um texto sem
// espaço; se não é `AAAA-MM-DD` possível, o campo vai para `invalid` e não vale. Literais (sem
// `new RegExp`): os sinais são os de {@link TASK_DATE_SYMBOLS}, com o seletor de variação opcional.
const DATE_REGEX: Readonly<Record<TaskDateField, RegExp>> = {
  due: /(?:📅|📆|🗓)\uFE0F? *(\S+)$/u,
  scheduled: /(?:⏳|⌛)\uFE0F? *(\S+)$/u,
  start: /🛫\uFE0F? *(\S+)$/u,
  created: /➕\uFE0F? *(\S+)$/u,
  done: /✅\uFE0F? *(\S+)$/u,
  cancelled: /❌\uFE0F? *(\S+)$/u,
};
const DATE_FIELDS = Object.keys(DATE_REGEX) as TaskDateField[];
const PRIORITY_REGEX = /([🔺⏫🔼🔽⏬])\uFE0F?$/u;
const RECURRENCE_REGEX = /🔁\uFE0F? ?([a-zA-Z0-9, !]+)$/iu;
/**
 * `#tag` (TaskRegularExpressions.hashTags, sem quebras de linha): grupo 2 = a tag com `#`. Global:
 * use com `matchAll` ou `search` (que ignoram `lastIndex`).
 */
export const HASH_TAGS = /(^|\s)(#[^\s!@#$%^&*(),.?":{}|<>]+)/gu;
const HASH_TAG_AT_END = /(^|\s)#[^\s!@#$%^&*(),.?":{}|<>]+$/u;
/** Link de bloco do Obsidian no fim (` ^id`): fica fora dos campos. */
const BLOCK_LINK = / \^[a-zA-Z0-9-]+$/u;
const MAX_RUNS = 20;

/** Trecho de um campo no corpo da linha: `[from, to)` cobre o sinal e o valor (sem o espaço antes). */
export interface TaskFieldSpan {
  readonly from: number;
  readonly to: number;
  /** Início do valor (a data) dentro do trecho. */
  readonly valueFrom: number;
}

/** Linha de tarefa decomposta (posições em unidades UTF-16 da linha crua). */
export interface TaskLineScan {
  readonly indent: string;
  readonly marker: string;
  /** Posição do caractere de estado (`[c]` → `c`). */
  readonly statusOffset: number;
  readonly status: string;
  /** Início do corpo (depois de `] `). */
  readonly bodyOffset: number;
  /**
   * Fim útil do corpo: antes do link de bloco e dos espaços do fim. A conclusão acrescenta campos
   * aqui.
   */
  readonly bodyEnd: number;
  /**
   * Trecho de cada campo com data VÁLIDA (o mais à esquerda, se repetido). Um campo inválido
   * (`✅ leite`) não tem trecho: é texto do usuário, que a conclusão nunca remove (r7 S9a B2).
   */
  readonly spans: Readonly<Partial<Record<TaskDateField, TaskFieldSpan>>>;
  readonly task: ParsedTask;
}

/** Decompõe uma linha de tarefa, ou `null` se a linha não é tarefa. `line` = número no documento. */
export function scanTaskLine(raw: string, line = -1): TaskLineScan | null {
  const m = TASK_LINE.exec(raw);
  if (!m) return null;
  const [head, indent = '', marker = '', gap = '', status = ' '] = m;
  const statusOffset = indent.length + marker.length + gap.length + 1;
  const bodyOffset = head.length;

  let rest = raw.slice(bodyOffset).replace(/\s+$/u, '');
  const block = BLOCK_LINK.exec(rest);
  if (block) rest = rest.slice(0, block.index).replace(/\s+$/u, '');
  const bodyEnd = bodyOffset + rest.length;

  const dates: Partial<Record<TaskDateField, string>> = {};
  const spans: Partial<Record<TaskDateField, TaskFieldSpan>> = {};
  const invalid: TaskDateField[] = [];
  let priority: TaskPriority | undefined;
  let recurrence: string | undefined;
  let trailingTags = '';

  for (let runs = 0, matched = true; matched && runs <= MAX_RUNS; runs++) {
    matched = false;
    const p = PRIORITY_REGEX.exec(rest);
    if (p) {
      priority = PRIORITY_SYMBOLS[p[1] as string];
      rest = rest.slice(0, p.index).trimEnd();
      matched = true;
    }
    for (const field of DATE_FIELDS) {
      const d = DATE_REGEX[field].exec(rest);
      if (!d) continue;
      const value = d[1] as string;
      if (isValidTaskDate(value)) {
        dates[field] = value;
        const from = bodyOffset + d.index;
        spans[field] = {
          from,
          to: from + d[0].length,
          valueFrom: from + d[0].length - value.length,
        };
      } else invalid.push(field);
      rest = rest.slice(0, d.index).trimEnd();
      matched = true;
    }
    const r = RECURRENCE_REGEX.exec(rest);
    if (r) {
      recurrence = (r[1] as string).trim().slice(0, TASK_RECURRENCE_MAX);
      rest = rest.slice(0, r.index).trimEnd();
      matched = true;
    }
    const t = HASH_TAG_AT_END.exec(rest);
    if (t) {
      trailingTags = `${t[0].trim()} ${trailingTags}`;
      rest = rest.slice(0, t.index).trimEnd();
      matched = true;
    }
  }

  const description = trailingTags === '' ? rest.trim() : `${rest.trim()} ${trailingTags.trim()}`;
  const tags: string[] = [];
  for (const tag of description.matchAll(HASH_TAGS)) {
    const name = tag[2] as string;
    if (!tags.includes(name)) tags.push(name);
  }
  const task: ParsedTask = {
    line,
    status,
    text: description.slice(0, TASK_TEXT_MAX),
    ...dates,
    priority: priority ?? NO_PRIORITY,
    ...(recurrence === undefined || recurrence === '' ? {} : { recurrence }),
    tags,
    invalid: DATE_FIELDS.filter((f) => invalid.includes(f) && dates[f] === undefined),
  };
  return {
    indent,
    marker,
    statusOffset,
    status,
    bodyOffset,
    bodyEnd,
    spans,
    task,
  };
}

/**
 * Tarefa de uma linha crua (R-I9.2), ou `null`. É o parser único do indexador, do
 * `TasksCatalog.parseTaskLine` e da conclusão (arch-backend r7 §1.7.5, §1.8).
 */
export function parseTaskLine(raw: string, line = -1): ParsedTask | null {
  return scanTaskLine(raw, line)?.task ?? null;
}

/**
 * Mesma tarefa, campo a campo, ignorando a linha (identidade de D-R7-B11b: a linha atual é "a
 * esperada" se o parser devolve exatamente o que o índice guardou).
 */
export function sameTask(a: ParsedTask, b: ParsedTask): boolean {
  return (
    a.status === b.status &&
    a.text === b.text &&
    a.priority === b.priority &&
    a.recurrence === b.recurrence &&
    DATE_FIELDS.every((f) => a[f] === b[f]) &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, i) => tag === b.tags[i]) &&
    a.invalid.length === b.invalid.length &&
    a.invalid.every((field, i) => field === b.invalid[i])
  );
}
