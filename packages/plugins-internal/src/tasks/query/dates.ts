/**
 * Datas das consultas (R-I9.4/R-I9.5): só `AAAA-MM-DD` de calendário real, comparadas como texto
 * (a ordem lexicográfica de `AAAA-MM-DD` é a cronológica). `today` segue o fuso local (R-I9.8).
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `AAAA-MM-DD` que existe no calendário (2026-02-30 → falso). */
export function isIsoDate(text: string): boolean {
  const match = ISO_DATE.exec(text);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Data local de `now` em `AAAA-MM-DD`. */
export function localIsoDate(now: Date): string {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `date` (válida) deslocada de `days` dias. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Milissegundos até a próxima meia-noite local (virada de `today`, R-I9.8). */
export function msUntilLocalMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(1, next.getTime() - now.getTime());
}
