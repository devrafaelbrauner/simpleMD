/**
 * Datas das tarefas (R-I9.2, R-I9.7, R-I9.8; arch-frontend r7 §10.6): só `AAAA-MM-DD`, sem fuso
 * nem hora. A aritmética trabalha sobre o calendário (dia/mês/ano), nunca sobre milissegundos
 * locais, então o horário de verão não desloca um dia. `today` segue o fuso local.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Dias do mês (`month` 1–12) no calendário gregoriano. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `AAAA-MM-DD` com mês e dia possíveis no calendário. */
export function isValidTaskDate(text: string): boolean {
  const m = DATE.exec(text);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

function format(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Partes de uma data já validada (chamador garante {@link isValidTaskDate}). */
function parts(date: string): [number, number, number] {
  return [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];
}

/** Dia do calendário como número de dias desde 1970-01-01 (para diferenças e somas exatas). */
function dayNumber(date: string): number {
  const [y, m, d] = parts(date);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

function fromDayNumber(n: number): string {
  const d = new Date(n * MS_PER_DAY);
  return format(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** A data de hoje no fuso local. */
export function localToday(now: Date = new Date()): string {
  return format(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** Milissegundos até a próxima meia-noite local (virada do `today`, R-I9.8). */
export function msUntilLocalMidnight(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(1, next.getTime() - now.getTime());
}

export function addDays(date: string, days: number): string {
  return fromDayNumber(dayNumber(date) + days);
}

/** Soma meses; dia que não existe no mês de chegada vira o último dia dele (31/01 + 1 → 28/02). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = parts(date);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return format(year, month, Math.min(d, daysInMonth(year, month)));
}

/** Soma anos; 29/02 num ano não bissexto vira 28/02. */
export function addYears(date: string, years: number): string {
  return addMonths(date, years * 12);
}

/** Diferença em dias `b - a`. */
export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

/** 0 = domingo … 6 = sábado. */
export function weekday(date: string): number {
  // 1970-01-01 foi quinta-feira (4).
  return (((dayNumber(date) + 4) % 7) + 7) % 7;
}

/** Próximo dia útil (segunda a sexta) depois de `date` (sexta → segunda). */
export function nextWeekday(date: string): string {
  let next = addDays(date, 1);
  while (weekday(next) === 0 || weekday(next) === 6) next = addDays(next, 1);
  return next;
}
