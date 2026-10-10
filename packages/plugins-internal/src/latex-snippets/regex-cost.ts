/**
 * Custo ESTÁTICO de uma regex do usuário (r7 I-6, R-I6.7, NFR-56; correção CR-S6-01/02/05): um
 * limite superior do número de caminhos de backtracking contra a janela testada, calculado sem
 * executar a regex. Um `RegExp.exec` é síncrono e não pode ser interrompido, então nada aqui mede
 * tempo nem roda a regex: a recusa vem antes de qualquer `exec`.
 *
 * Regras (sobre o source JÁ com as variáveis `${GREEK}`… trocadas):
 * - quantificador = `*`, `+`, `?`, `{m,}`, `{m,n}` com n > m (o `?` e o `{0,1}` contam);
 * - grupo quantificado que contém quantificador ou alternância = altura de estrela > 1 (`(a+)+`,
 *   `(xx?)+`, `(a|a)*`) → custo infinito;
 * - no resto, o custo de uma sequência é o PRODUTO das escolhas de cada termo (quantificador = nº
 *   de repetições possíveis dentro da janela; `?` = 2; alternância = soma dos ramos), vezes o nº de
 *   posições de início. Pega também as formas sem aninhamento (`a?a?…aa…`, `(a|a)(a|a)…`,
 *   `\w*\w*\w*…`).
 */

/** Texto testado a cada tecla: `SNIPPET_WINDOW` (100) caracteres antes do cursor + a tecla. */
const WINDOW_TEXT = 101;

/**
 * Custo máximo de UMA regex (caminhos × inícios): cabe `\w*\w*x` (≈ 1,05 × 10⁶; pior caso medido
 * ≈ 1,5 ms numa janela de 101 caracteres), também com um prefixo opcional (× 2); `\w*\w*\w*x`
 * (≈ 10⁸; ≈ 40 ms) fica fora.
 */
export const REGEX_COST_LIMIT = 2_500_000;

/** Soma máxima dos custos das regex de UM arquivo do usuário (orçamento total por arquivo). */
export const FILE_REGEX_COST_LIMIT = 10_000_000;

interface Term {
  /** Limite superior de formas de casar um mesmo trecho. */
  readonly paths: number;
  /** Contém quantificador ou alternância (repeti-lo seria altura de estrela > 1). */
  readonly ambiguous: boolean;
}

const DETERMINISTIC: Term = { paths: 1, ambiguous: false };
const REJECT: Term = { paths: Infinity, ambiguous: true };

class Scanner {
  i = 0;
  constructor(readonly src: string) {}

  get done(): boolean {
    return this.i >= this.src.length;
  }

  peek(offset = 0): string {
    return this.src.charAt(this.i + offset);
  }
}

/**
 * Custo estático de `source` (sem o `$` do fim): caminhos × inícios, ou `Infinity` para altura de
 * estrela > 1 ou um source que este analisador não entende (recusar é o lado seguro).
 */
export function regexCost(source: string): number {
  const scanner = new Scanner(source);
  const top = alternation(scanner);
  if (!scanner.done) return Infinity;
  return top.paths * WINDOW_TEXT;
}

function alternation(s: Scanner): Term {
  let paths = 0;
  let ambiguous = false;
  let branches = 0;
  for (;;) {
    const branch = sequence(s);
    paths += branch.paths;
    ambiguous ||= branch.ambiguous;
    branches++;
    if (s.peek() !== '|') break;
    s.i++;
  }
  return { paths, ambiguous: ambiguous || branches > 1 };
}

function sequence(s: Scanner): Term {
  let paths = 1;
  let ambiguous = false;
  while (!s.done && s.peek() !== '|' && s.peek() !== ')') {
    const t = term(s);
    paths *= t.paths;
    ambiguous ||= t.ambiguous;
    if (paths === Infinity) return REJECT;
  }
  return { paths, ambiguous };
}

function term(s: Scanner): Term {
  const unit = atom(s);
  const q = quantifier(s);
  if (q === null || (q.min === 1 && q.max === 1)) return unit;
  if (q.max === 0) return DETERMINISTIC;
  // Repetir algo que já tem mais de uma forma de casar: backtracking exponencial.
  if (unit.ambiguous || unit.paths > 1) return REJECT;
  const choices = Math.max(1, Math.min(q.max, WINDOW_TEXT) - Math.min(q.min, WINDOW_TEXT) + 1);
  return { paths: choices, ambiguous: choices > 1 };
}

/** `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}` (e o `?` preguiçoso depois); `null` = sem quantificador. */
function quantifier(s: Scanner): { readonly min: number; readonly max: number } | null {
  const ch = s.peek();
  let q: { min: number; max: number } | null = null;
  if (ch === '*') q = { min: 0, max: Infinity };
  else if (ch === '+') q = { min: 1, max: Infinity };
  else if (ch === '?') q = { min: 0, max: 1 };
  if (q) s.i++;
  else if (ch === '{') {
    const braces = /^\{(\d+)(,(\d*))?\}/.exec(s.src.slice(s.i));
    if (!braces) return null;
    const min = Number(braces[1]);
    const max = braces[2] === undefined ? min : braces[3] ? Number(braces[3]) : Infinity;
    q = { min, max };
    s.i += braces[0].length;
  } else return null;
  if (s.peek() === '?') s.i++;
  return q;
}

function atom(s: Scanner): Term {
  const ch = s.peek();
  if (ch === '(') return group(s);
  if (ch === '[') return charClass(s);
  if (ch === '\\') return escape(s);
  // Quantificador sem átomo não compila; aqui só por segurança.
  if (ch === '*' || ch === '+' || ch === '?') return REJECT;
  s.i++;
  return DETERMINISTIC;
}

function group(s: Scanner): Term {
  s.i++; // (
  if (s.peek() === '?') {
    s.i++;
    const kind = s.peek();
    if (kind === ':' || kind === '=' || kind === '!') s.i++;
    else if (kind === '<' && (s.peek(1) === '=' || s.peek(1) === '!')) s.i += 2;
    else {
      // `(?<nome>` ou modificadores `(?i:`: até o `>`/`:`.
      const end = s.src.slice(s.i).search(/[>:]/);
      if (end === -1) return REJECT;
      s.i += end + 1;
    }
  }
  const inner = alternation(s);
  if (s.peek() !== ')') return REJECT;
  s.i++;
  return inner;
}

function charClass(s: Scanner): Term {
  s.i++; // [
  while (!s.done && s.peek() !== ']') s.i += s.peek() === '\\' ? 2 : 1;
  if (s.done) return REJECT;
  s.i++;
  return DETERMINISTIC;
}

function escape(s: Scanner): Term {
  const next = s.peek(1);
  if (!next) return REJECT;
  s.i += 2;
  // `\u{…}`, `\p{…}`, `\P{…}`, `\k<…>`: um átomo só.
  const close = (next === 'u' || next === 'p' || next === 'P') && s.peek() === '{' ? '}' : null;
  const name = next === 'k' && s.peek() === '<' ? '>' : null;
  const end = close ?? name;
  if (end) {
    const at = s.src.indexOf(end, s.i);
    if (at === -1) return REJECT;
    s.i = at + 1;
  }
  return DETERMINISTIC;
}
