/**
 * Parser do bloco ```` ```tasks ```` (R-I9.4, AC-I9.3). Reescrito para o simpleMD a partir das
 * ideias de `src/Query/**` do obsidian-tasks 8.4.0 (MIT; nenhum código copiado): uma instrução por
 * linha, sem diferença de caixa nas instruções; `AND`/`OR`/`NOT` (maiúsculos, como no Tasks) só em
 * combinações com parênteses. Qualquer linha fora da gramática → erro "Instrução não reconhecida na
 * linha N: <texto>" e nenhum resultado.
 */
import { addDays, isIsoDate } from './dates';

export const QUERY_LIMIT_MAX = 1000;

export type TaskDateKey = 'due' | 'scheduled' | 'start' | 'done' | 'created';

/** Prioridade do índice (R-I9.2): 5 máxima, 4 alta, 3 média, 2 nenhuma, 1 baixa, 0 mínima. */
export type PriorityLevel = 0 | 1 | 2 | 3 | 4 | 5;

export const PRIORITY_NAMES: Readonly<Record<string, PriorityLevel>> = {
  highest: 5,
  high: 4,
  medium: 3,
  none: 2,
  low: 1,
  lowest: 0,
};

/** Data de uma instrução: absoluta ou relativa a `today` (resolvida na avaliação, R-I9.8). */
export type DateRef = { readonly date: string } | { readonly offset: -1 | 0 | 1 };

export type TaskFilter =
  | { readonly kind: 'done'; readonly done: boolean }
  | {
      readonly kind: 'date';
      readonly field: TaskDateKey;
      readonly op: 'before' | 'after' | 'on';
      readonly date: DateRef;
    }
  | { readonly kind: 'has-date'; readonly field: Exclude<TaskDateKey, 'created'>; readonly has: boolean }
  | { readonly kind: 'path'; readonly includes: boolean; readonly text: string }
  | { readonly kind: 'tag'; readonly includes: boolean; readonly tag: string }
  | { readonly kind: 'description'; readonly includes: boolean; readonly text: string }
  | { readonly kind: 'priority'; readonly cmp: 'is' | 'above' | 'below'; readonly level: PriorityLevel }
  | { readonly kind: 'recurring'; readonly recurring: boolean }
  | { readonly kind: 'and' | 'or'; readonly operands: readonly TaskFilter[] }
  | { readonly kind: 'not'; readonly operand: TaskFilter };

export type TaskSortKey = 'due' | 'scheduled' | 'start' | 'done' | 'priority' | 'path' | 'description';
export type TaskGroupKey = 'path' | 'folder' | 'filename' | 'due' | 'priority' | 'tags';
export type TaskHideKey =
  | 'due date'
  | 'scheduled date'
  | 'start date'
  | 'done date'
  | 'priority'
  | 'recurrence rule'
  | 'backlink';

export interface TasksQuery {
  readonly kind: 'tasks';
  readonly filters: readonly TaskFilter[];
  readonly sort: readonly { readonly key: TaskSortKey; readonly reverse: boolean }[];
  readonly group: readonly TaskGroupKey[];
  /** `limit n` (≤ 1.000) ou `null` (o avaliador aplica o teto de 1.000). */
  readonly limit: number | null;
  readonly hide: ReadonlySet<TaskHideKey>;
  readonly shortMode: boolean;
}

export interface QueryError {
  readonly kind: 'error';
  /** Texto vinculante STR-177 (R-I9.4/R-I9.5). */
  readonly message: string;
  /** Linha 1-based dentro do bloco (0 = o bloco inteiro). */
  readonly line: number;
}

export const unrecognized = (line: number, text: string): QueryError => ({
  kind: 'error',
  message: `Instrução não reconhecida na linha ${line}: ${text}`,
  line,
});

const DATE_FIELD: Readonly<Record<string, TaskDateKey>> = {
  due: 'due',
  scheduled: 'scheduled',
  starts: 'start',
  done: 'done',
  created: 'created',
};

function parseDateRef(text: string): DateRef | null {
  const word = text.toLowerCase();
  if (word === 'today') return { offset: 0 };
  if (word === 'tomorrow') return { offset: 1 };
  if (word === 'yesterday') return { offset: -1 };
  return isIsoDate(text) ? { date: text } : null;
}

/** `today` resolvido no dia de `today` (`AAAA-MM-DD`). */
export function resolveDateRef(ref: DateRef, today: string): string {
  return 'date' in ref ? ref.date : addDays(today, ref.offset);
}

const SIMPLE: readonly [RegExp, (m: RegExpExecArray) => TaskFilter | null][] = [
  [/^done$/i, () => ({ kind: 'done', done: true })],
  [/^not done$/i, () => ({ kind: 'done', done: false })],
  [
    /^(due|scheduled|starts|done|created) (before|after|on) (\S+)$/i,
    (m) => {
      const date = parseDateRef(m[3]!);
      return date
        ? {
            kind: 'date',
            field: DATE_FIELD[m[1]!.toLowerCase()]!,
            op: m[2]!.toLowerCase() as 'before' | 'after' | 'on',
            date,
          }
        : null;
    },
  ],
  [
    /^(has|no) (due|scheduled|start|done) date$/i,
    (m) => ({
      kind: 'has-date',
      field: m[2]!.toLowerCase() as Exclude<TaskDateKey, 'created'>,
      has: m[1]!.toLowerCase() === 'has',
    }),
  ],
  [
    /^path (includes|does not include) (.+)$/i,
    (m) => ({ kind: 'path', includes: m[1]!.toLowerCase() === 'includes', text: m[2]!.trim() }),
  ],
  [
    /^(?:tags (include|do not include)|tag (includes|does not include)) (#[^\s#]+)$/i,
    (m) => ({
      kind: 'tag',
      includes: (m[1] ?? m[2])!.toLowerCase().startsWith('include'),
      tag: m[3]!,
    }),
  ],
  [
    /^description (includes|does not include) (.+)$/i,
    (m) => ({
      kind: 'description',
      includes: m[1]!.toLowerCase() === 'includes',
      text: m[2]!.trim(),
    }),
  ],
  [
    /^priority is (?:(above|below) )?(highest|high|medium|none|low|lowest)$/i,
    (m) => ({
      kind: 'priority',
      cmp: (m[1]?.toLowerCase() ?? 'is') as 'is' | 'above' | 'below',
      level: PRIORITY_NAMES[m[2]!.toLowerCase()]!,
    }),
  ],
  [/^is recurring$/i, () => ({ kind: 'recurring', recurring: true })],
  [/^is not recurring$/i, () => ({ kind: 'recurring', recurring: false })],
];

function parseSimple(text: string): TaskFilter | null {
  const normalized = text.trim().replace(/\s+/g, ' ');
  for (const [pattern, build] of SIMPLE) {
    const match = pattern.exec(normalized);
    if (match) return build(match);
  }
  return null;
}

/**
 * Combinação booleana: `(a) AND (b)`, `(a) OR (b) OR (c)`, `NOT (a)`, aninhada por parênteses.
 * Precedência: `NOT` > `AND` > `OR`. Devolve `null` quando a linha não é uma combinação válida.
 */
function parseBoolean(text: string): TaskFilter | null {
  let pos = 0;
  const skip = () => {
    while (text[pos] === ' ' || text[pos] === '\t') pos++;
  };
  const keyword = (word: string) => {
    skip();
    if (!text.startsWith(word, pos)) return false;
    const after = text[pos + word.length];
    if (after !== undefined && after !== ' ' && after !== '\t' && after !== '(') return false;
    pos += word.length;
    return true;
  };

  const group = (): TaskFilter | null => {
    skip();
    if (text[pos] !== '(') return null;
    // Parêntese casado: o conteúdo é outra combinação ou uma instrução simples.
    let depth = 0;
    let end = pos;
    for (; end < text.length; end++) {
      if (text[end] === '(') depth++;
      else if (text[end] === ')' && --depth === 0) break;
    }
    if (depth !== 0) return null;
    const inner = text.slice(pos + 1, end).trim();
    pos = end + 1;
    return parseSimple(inner) ?? parseBoolean(inner);
  };
  const unary = (): TaskFilter | null => {
    if (keyword('NOT')) {
      const operand = unary();
      return operand ? { kind: 'not', operand } : null;
    }
    return group();
  };
  const sequence = (op: 'AND' | 'OR', next: () => TaskFilter | null): TaskFilter | null => {
    const first = next();
    if (!first) return null;
    const operands = [first];
    while (keyword(op)) {
      const operand = next();
      if (!operand) return null;
      operands.push(operand);
    }
    return operands.length === 1 ? first : { kind: op === 'AND' ? 'and' : 'or', operands };
  };

  const result = sequence('OR', () => sequence('AND', unary));
  skip();
  return result && pos === text.length ? result : null;
}

const SORT = /^sort by (due|scheduled|start|done|priority|path|description)( reverse)?$/i;
const GROUP = /^group by (path|folder|filename|due|priority|tags)$/i;
const LIMIT = /^limit (?:to )?(\d+)(?: tasks)?$/i;
const HIDE =
  /^(hide|show) (due date|scheduled date|start date|done date|priority|recurrence rule|backlink)$/i;

/** Analisa o texto de um bloco ```` ```tasks ````. */
export function parseTasksQuery(source: string): TasksQuery | QueryError {
  const filters: TaskFilter[] = [];
  const sort: { key: TaskSortKey; reverse: boolean }[] = [];
  const group: TaskGroupKey[] = [];
  const hide = new Set<TaskHideKey>();
  let limit: number | null = null;
  let shortMode = false;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\r$/, '');
    const text = raw.trim().replace(/\s+/g, ' ');
    if (text === '') continue;
    const n = i + 1;
    let match: RegExpExecArray | null;
    if ((match = SORT.exec(text))) {
      sort.push({ key: match[1]!.toLowerCase() as TaskSortKey, reverse: Boolean(match[2]) });
    } else if ((match = GROUP.exec(text))) {
      group.push(match[1]!.toLowerCase() as TaskGroupKey);
    } else if ((match = LIMIT.exec(text))) {
      const value = Number(match[1]);
      if (value > QUERY_LIMIT_MAX) return unrecognized(n, raw.trim());
      limit = value;
    } else if ((match = HIDE.exec(text))) {
      const key = match[2]!.toLowerCase() as TaskHideKey;
      if (match[1]!.toLowerCase() === 'hide') hide.add(key);
      else hide.delete(key);
    } else if (/^short mode$/i.test(text)) {
      shortMode = true;
    } else {
      const filter =
        parseSimple(text) ??
        (text.startsWith('(') || text.startsWith('NOT') ? parseBoolean(text) : null);
      if (!filter) return unrecognized(n, raw.trim());
      filters.push(filter);
    }
  }
  return { kind: 'tasks', filters, sort, group, limit, hide, shortMode };
}
