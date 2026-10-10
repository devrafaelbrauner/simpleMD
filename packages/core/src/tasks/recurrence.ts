import { addDays, addMonths, addYears, nextWeekday } from './dates';

/**
 * Subconjunto de recorrência de R-I9.7 (arch-frontend r7 §10.6), reescrito sem `rrule`/`moment`
 * (ideia de `src/Task/Recurrence.ts` do obsidian-tasks 8.4.0): `every [N] day(s)|week(s)|month(s)|
 * year(s) [when done]` e `every weekday [when done]`. Qualquer outra regra fica de fora: a tarefa
 * só alterna e o app avisa nomeando a regra (STR-145).
 */
export interface RecurrenceRule {
  readonly unit: 'day' | 'week' | 'month' | 'year' | 'weekday';
  /** N ≥ 1 (1 para `weekday`). */
  readonly interval: number;
  /** Datas novas a partir da data de conclusão, não das datas da tarefa. */
  readonly whenDone: boolean;
}

const PERIODIC = /^every\s+(?:(\d{1,4})\s+)?(day|week|month|year)s?(\s+when\s+done)?$/i;
const WEEKDAY = /^every\s+weekday(\s+when\s+done)?$/i;

/** Regra do subconjunto, ou `null` se o texto está fora dele. */
export function parseRecurrence(text: string): RecurrenceRule | null {
  const rule = text.trim().replace(/\s+/g, ' ');
  const weekday = WEEKDAY.exec(rule);
  if (weekday) return { unit: 'weekday', interval: 1, whenDone: weekday[1] !== undefined };
  const m = PERIODIC.exec(rule);
  if (!m) return null;
  const interval = m[1] === undefined ? 1 : Number(m[1]);
  if (interval < 1) return null;
  return {
    unit: (m[2] as string).toLowerCase() as RecurrenceRule['unit'],
    interval,
    whenDone: m[3] !== undefined,
  };
}

/** Próxima ocorrência depois de `reference` (`AAAA-MM-DD` válido); mês curto → último dia. */
export function nextOccurrence(rule: RecurrenceRule, reference: string): string {
  switch (rule.unit) {
    case 'day':
      return addDays(reference, rule.interval);
    case 'week':
      return addDays(reference, 7 * rule.interval);
    case 'month':
      return addMonths(reference, rule.interval);
    case 'year':
      return addYears(reference, rule.interval);
    case 'weekday':
      return nextWeekday(reference);
  }
}
