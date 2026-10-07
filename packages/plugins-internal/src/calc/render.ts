import { evaluate } from './parse';

/** Teto do token calc, incluindo o `=` (R-7.4). */
export const CALC_MAX_LENGTH = 200;
/** STR-88 (vinculante). */
export const DIV0_TEXT = 'divisão por zero';

const CALC_TOKEN = /^=[0-9.+\-*/%^()]+$/;

export interface CalcRender {
  /** Texto visível do widget: `5` ou "divisão por zero". */
  readonly text: string;
  /** Nome acessível (STR-87/88): `=2+3 = 5` ou `=1/0: divisão por zero`. */
  readonly label: string;
  readonly error: boolean;
}

/**
 * Até 10 algarismos significativos e sem zeros à direita (`0.1+0.2` → `0.3`); `-0` vira `0`.
 */
export function formatResult(value: number): string {
  return String(Number(value.toPrecision(10)) + 0);
}

/**
 * Resultado de um token calc completo (`=2+3`), ou `null` quando ele não é calc: caractere fora da
 * gramática, mais de 200 caracteres, sem operador binário ou erro de sintaxe (R-7.4). Função pura,
 * também usada pela exportação (arch-frontend r2 §10.2).
 */
export function renderCalc(token: string): CalcRender | null {
  if (token.length > CALC_MAX_LENGTH || !CALC_TOKEN.test(token)) return null;
  const outcome = evaluate(token.slice(1));
  if (outcome === null) return null;
  if (outcome.kind === 'div0')
    return { text: DIV0_TEXT, label: `${token}: ${DIV0_TEXT}`, error: true };
  const text = formatResult(outcome.value);
  return { text, label: `${token} = ${text}`, error: false };
}

const isSpace = (char: string | undefined) => char === ' ' || char === '\t';

/**
 * Candidatos a token calc num texto (R-7.4; o editor passa uma linha, a exportação o texto de um
 * bloco): começa com `=` no início de uma linha ou depois de espaço/tab e vai até o próximo espaço,
 * tab ou quebra de linha; no máximo 200 caracteres. Quem chama exclui código, front matter e
 * matemática e decide com {@link renderCalc}.
 */
export function calcTokenSpans(text: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let i = text.indexOf('='); i !== -1; i = text.indexOf('=', i + 1)) {
    if (i > 0 && !isSpace(text[i - 1]) && text[i - 1] !== '\n') continue;
    let end = i + 1;
    while (end < text.length && !isSpace(text[end]) && text[end] !== '\n') end++;
    if (end - i > CALC_MAX_LENGTH) continue;
    out.push({ from: i, to: end });
  }
  return out;
}
